/**
 * Intent records.
 *
 * An intent is the phone's statement of what it meant to do. It is never a
 * statement about what happened — that is a verdict, and only a chain
 * snapshot can produce one.
 *
 * The construction order here is step 1 through step 5 of the write-ahead
 * sequence. `createIntentRecord` is what gets handed to
 * `IntentStore.putIntentDurably`, and nothing may call the wallet until that
 * write has returned.
 */

import { buildContributionTransaction } from './builder.ts';
import type { BuildContributionArgs } from './builder.ts';
import type {
  Base58PublicKey,
  IntentRecord,
  RawAmount,
  WalletCapabilityRecord,
} from './types.ts';

export interface CreateIntentArgs {
  readonly slotId: string;
  readonly circleId: string;
  readonly roundIndex: number;
  readonly memberPubkey: Base58PublicKey;

  readonly sourceTokenAccount: Base58PublicKey;
  readonly destinationTokenAccount: Base58PublicKey;
  readonly mint: Base58PublicKey;
  readonly mintDecimals: number;
  readonly rawAmount: RawAmount;

  readonly noncePubkey: Base58PublicKey;
  readonly nonceAuthority: Base58PublicKey;
  /** The value read out of the nonce account at `builtAtChainSlot`. */
  readonly nonceValue: string;
  /** The chain slot the nonce value was read at. Bounds the signature search. */
  readonly builtAtChainSlot: number;

  readonly walletCapabilities: WalletCapabilityRecord;
  /** Device clock, used for ordering and display only, never for a verdict. */
  readonly createdAtMs: number;
}

/**
 * A slot id that is stable across reinstalls and derivable by the verifier.
 *
 * Deliberately not random: the verifier must be able to confirm that the
 * intent it is reading belongs to the circle, round, and member the evidence
 * log says it does, without trusting a locally generated identifier.
 */
export function deriveSlotId(
  circleId: string,
  roundIndex: number,
  memberPubkey: Base58PublicKey,
): string {
  if (!Number.isInteger(roundIndex) || roundIndex < 0) {
    throw new Error('deriveSlotId: roundIndex must be a non-negative integer');
  }
  return `${circleId}:${roundIndex}:${memberPubkey}`;
}

/**
 * Steps 1 through 4 of the write-ahead sequence, as one pure call.
 *
 * Returns the record and the built transaction together. The caller persists
 * the record (step 5) and only then hands the transaction to the wallet
 * (step 6). Splitting them any other way is how an app ends up with a
 * transaction in flight that nothing on disk describes.
 */
export function createIntentRecord(args: CreateIntentArgs): {
  readonly intent: IntentRecord;
  readonly built: ReturnType<typeof buildContributionTransaction>;
} {
  validateCreateIntentArgs(args);

  const buildArgs: BuildContributionArgs = {
    memberPubkey: args.memberPubkey,
    sourceTokenAccount: args.sourceTokenAccount,
    destinationTokenAccount: args.destinationTokenAccount,
    mint: args.mint,
    mintDecimals: args.mintDecimals,
    rawAmount: args.rawAmount,
    noncePubkey: args.noncePubkey,
    nonceAuthority: args.nonceAuthority,
    nonceValue: args.nonceValue,
  };

  const built = buildContributionTransaction(buildArgs);

  const intent: IntentRecord = {
    schemaVersion: 1,
    slotId: args.slotId,
    circleId: args.circleId,
    roundIndex: args.roundIndex,
    memberPubkey: args.memberPubkey,
    noncePubkey: args.noncePubkey,
    nonceValueAtBuild: args.nonceValue,
    nonceAuthority: args.nonceAuthority,
    messageHash: built.messageHash,
    messageBase64: built.messageBase64,
    transfer: {
      expectedFrom: args.memberPubkey,
      expectedTo: args.destinationTokenAccount,
      expectedMint: args.mint,
      expectedAmount: args.rawAmount,
      mintDecimals: args.mintDecimals,
    },
    // Populated only if the wallet implements the optional `signTransactions`
    // method and returns bytes. Nothing depends on it.
    signedTransactionBase64: null,
    walletCapabilities: args.walletCapabilities,
    createdAtMs: args.createdAtMs,
    builtAtChainSlot: args.builtAtChainSlot,
  };

  return { intent, built };
}

/**
 * Attach signed bytes returned by the optional `signTransactions` path.
 *
 * An optimization and nothing more: it lets recovery rebroadcast the exact
 * bytes the wallet produced instead of asking the wallet again. Every verdict
 * must be identical with or without it, and
 * `test/verdict.unavailable.test.ts` forces the absent path across the whole
 * state table to prove it.
 */
export function withSignedBytes(
  intent: IntentRecord,
  signedTransactionBase64: string,
): IntentRecord {
  if (!intent.walletCapabilities.supportsSignTransactions) {
    throw new Error(
      'Signed bytes were offered for a wallet whose capability probe did not report ' +
        'signTransactions. Recording them would misattribute the evidence.',
    );
  }
  return { ...intent, signedTransactionBase64 };
}

function validateCreateIntentArgs(args: CreateIntentArgs): void {
  if (args.slotId !== deriveSlotId(args.circleId, args.roundIndex, args.memberPubkey)) {
    throw new Error(
      'slotId does not match the circle, round, and member it claims. A slot id must be ' +
        'derivable so the verifier can confirm it without trusting the device.',
    );
  }
  if (args.rawAmount <= 0n) {
    throw new Error('A contribution amount must be positive');
  }
  if (!Number.isInteger(args.mintDecimals) || args.mintDecimals < 0 || args.mintDecimals > 18) {
    throw new Error('mintDecimals must be an integer between 0 and 18');
  }
  if (!Number.isInteger(args.builtAtChainSlot) || args.builtAtChainSlot < 0) {
    throw new Error('builtAtChainSlot must be a non-negative integer');
  }
  if (args.nonceValue.length === 0) {
    throw new Error('A nonce value is required: it is the field the oracle compares against');
  }
  if (!args.walletCapabilities.supportsSignAndSendTransactions) {
    throw new Error(
      'This wallet does not report signAndSendTransactions, which MWA 2.0 makes mandatory. ' +
        'Quittance will not build a contribution it has no guaranteed way to broadcast.',
    );
  }
  if (args.sourceTokenAccount === args.destinationTokenAccount) {
    throw new Error('A contribution cannot pay from and to the same token account');
  }
}

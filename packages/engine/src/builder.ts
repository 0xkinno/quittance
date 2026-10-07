/**
 * Durable-nonce transaction construction.
 *
 * Two rules govern every transaction this module produces, and both are
 * requirements of the runtime rather than preferences of ours:
 *
 *   1. `AdvanceNonceAccount` is the **first** instruction. The runtime reads
 *      the nonce authority's signature from instruction index 0
 *      (`NONCED_TX_MARKER_IX_INDEX`, see `docs/runtime-citations.md` C2), so
 *      a nonce transaction whose advance is not first is not a nonce
 *      transaction at all. It also means the nonce account appears in the
 *      first instruction of every transaction that touches it, which is what
 *      makes `getSignaturesForAddress(nonceAccount)` a complete index.
 *
 *   2. The message's `recentBlockhash` field carries the **stored nonce
 *      value**, not a recent blockhash. That substitution is the whole
 *      mechanism: validation falls through from the age check to the nonce
 *      check (C1), so the transaction never expires while the nonce holds.
 *
 * The transfer uses `transferChecked` rather than `transfer` so that the mint
 * and its decimals are asserted by the token program. A contribution that
 * names the wrong mint fails on chain instead of moving the wrong asset.
 */

import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import { bytesToBase64, hashCompiledMessage } from './canonical.ts';
import type { Base58PublicKey, RawAmount, Sha256Hex } from './types.ts';

/** The SPL Token program. */
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** `TransferChecked` is instruction 12 in the SPL Token instruction layout. */
const TRANSFER_CHECKED_INSTRUCTION = 12;

export interface BuildContributionArgs {
  /** The member's wallet, the fee payer and the source authority. */
  readonly memberPubkey: Base58PublicKey;
  /** The member's token account for the contribution mint. */
  readonly sourceTokenAccount: Base58PublicKey;
  /** The circle vault's token account. */
  readonly destinationTokenAccount: Base58PublicKey;
  readonly mint: Base58PublicKey;
  readonly mintDecimals: number;
  readonly rawAmount: RawAmount;

  /** The leased nonce account. */
  readonly noncePubkey: Base58PublicKey;
  /** The lease's authority, which signs instruction 0. */
  readonly nonceAuthority: Base58PublicKey;
  /** The nonce value read out of that account, base58. */
  readonly nonceValue: string;
}

export interface BuiltContribution {
  /** The unsigned transaction, ready to hand to the wallet. */
  readonly transaction: Transaction;
  /** The compiled message bytes. */
  readonly messageBytes: Uint8Array;
  readonly messageBase64: string;
  /** sha256 over the compiled message. The identity the verdict machine uses. */
  readonly messageHash: Sha256Hex;
}

/**
 * Build the SPL `TransferChecked` instruction by hand.
 *
 * Written out rather than pulled from a helper package because the account
 * order and the data layout are part of what the message hash commits to, and
 * a reviewer checking that the hash means what the README says it means
 * should be able to read the bytes here without resolving a dependency.
 */
export function createTransferCheckedInstruction(args: {
  readonly source: PublicKey;
  readonly mint: PublicKey;
  readonly destination: PublicKey;
  readonly owner: PublicKey;
  readonly rawAmount: RawAmount;
  readonly decimals: number;
}): TransactionInstruction {
  if (args.rawAmount <= 0n) {
    throw new Error('createTransferCheckedInstruction: amount must be positive');
  }
  if (args.rawAmount > 0xffffffffffffffffn) {
    throw new Error('createTransferCheckedInstruction: amount exceeds u64');
  }
  if (!Number.isInteger(args.decimals) || args.decimals < 0 || args.decimals > 255) {
    throw new Error('createTransferCheckedInstruction: decimals must fit in a u8');
  }

  const data = new Uint8Array(10);
  data[0] = TRANSFER_CHECKED_INSTRUCTION;
  let remaining = args.rawAmount;
  for (let i = 0; i < 8; i += 1) {
    data[1 + i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  data[9] = args.decimals;

  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: args.destination, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

/**
 * Build one contribution transaction anchored to a durable nonce.
 *
 * The transaction is returned unsigned. Under the mandatory MWA 2.0 signing
 * path the app never holds signed bytes at all — the wallet signs and
 * broadcasts — so nothing here attempts to sign, and the message hash is
 * computed over the message precisely because the signature is not available
 * to commit to.
 */
export function buildContributionTransaction(
  args: BuildContributionArgs,
): BuiltContribution {
  const member = new PublicKey(args.memberPubkey);
  const nonceAccount = new PublicKey(args.noncePubkey);
  const nonceAuthority = new PublicKey(args.nonceAuthority);

  const advance = SystemProgram.nonceAdvance({
    noncePubkey: nonceAccount,
    authorizedPubkey: nonceAuthority,
  });

  const transfer = createTransferCheckedInstruction({
    source: new PublicKey(args.sourceTokenAccount),
    mint: new PublicKey(args.mint),
    destination: new PublicKey(args.destinationTokenAccount),
    owner: member,
    rawAmount: args.rawAmount,
    decimals: args.mintDecimals,
  });

  const transaction = new Transaction();
  // Order is not cosmetic. The advance must be instruction 0.
  transaction.add(advance, transfer);
  transaction.feePayer = member;
  // The nonce value occupies the blockhash field. This is the substitution
  // that makes the transaction immune to expiry.
  transaction.recentBlockhash = args.nonceValue;
  transaction.nonceInfo = {
    nonce: args.nonceValue,
    nonceInstruction: advance,
  };

  const messageBytes = new Uint8Array(transaction.serializeMessage());
  assertAdvanceIsFirstInstruction(transaction);

  return {
    transaction,
    messageBytes,
    messageBase64: bytesToBase64(messageBytes),
    messageHash: hashCompiledMessage(messageBytes),
  };
}

/**
 * Refuse to emit a transaction whose first instruction is not the advance.
 *
 * A guard rather than a comment, because this is the one structural mistake
 * that would silently turn every transaction in the system back into an
 * expiring one and quietly dissolve the guarantee.
 */
export function assertAdvanceIsFirstInstruction(transaction: Transaction): void {
  const first = transaction.instructions[0];
  if (first === undefined) {
    throw new Error('A contribution transaction must carry instructions');
  }
  if (!first.programId.equals(SystemProgram.programId)) {
    throw new Error(
      'The first instruction of a contribution transaction must be AdvanceNonceAccount, ' +
        `and it is addressed to ${first.programId.toBase58()}. Without the advance first, ` +
        'the runtime will not treat this as a nonce transaction and the guarantee is gone.',
    );
  }
  const advanceDiscriminator = first.data.length >= 4 ? first.data.readUInt32LE(0) : -1;
  // `AdvanceNonceAccount` is variant 4 of the System instruction enum.
  if (advanceDiscriminator !== 4) {
    throw new Error(
      'The first instruction is a System instruction but not AdvanceNonceAccount ' +
        `(variant ${advanceDiscriminator}).`,
    );
  }
}

/**
 * Build the standalone advance used by the reissue path and by lease
 * recycling.
 *
 * On the reissue path this transaction is what makes *Mark unpaid and
 * reissue* safe: once this advance confirms, the superseded contribution
 * transaction can never land, because its nonce field no longer matches the
 * account's stored value (C2). The replacement is not built until then.
 */
export function buildNonceAdvanceTransaction(args: {
  readonly noncePubkey: Base58PublicKey;
  readonly nonceAuthority: Base58PublicKey;
  readonly feePayer: Base58PublicKey;
  /** A genuine recent blockhash. This transaction is allowed to expire. */
  readonly recentBlockhash: string;
}): Transaction {
  const transaction = new Transaction();
  transaction.add(
    SystemProgram.nonceAdvance({
      noncePubkey: new PublicKey(args.noncePubkey),
      authorizedPubkey: new PublicKey(args.nonceAuthority),
    }),
  );
  transaction.feePayer = new PublicKey(args.feePayer);
  transaction.recentBlockhash = args.recentBlockhash;
  return transaction;
}

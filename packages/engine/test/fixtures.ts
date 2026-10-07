/**
 * Test fixtures.
 *
 * These build *real* compiled transaction messages with real public keys, not
 * hand-written byte strings. That matters: the verdict machine's identity test
 * is a sha256 over compiled message bytes, so a test that hashed a fake
 * message would prove the hash function works and nothing about whether the
 * machine recognises its own transaction. Here, a "matching" snapshot matches
 * because it carries the same message the builder produced.
 *
 * Nothing here touches the network. Every snapshot is constructed in memory.
 */

import { Keypair } from '@solana/web3.js';

import { buildContributionTransaction } from '../src/builder.ts';
import { createIntentRecord, deriveSlotId } from '../src/intent.ts';
import type {
  ChainSnapshot,
  IntentRecord,
  SignatureEntry,
  TransactionSnapshot,
  WalletCapabilityRecord,
} from '../src/types.ts';

/** A deterministic-enough unique base58 32-byte value, usable as a nonce. */
export function freshNonceValue(): string {
  return Keypair.generate().publicKey.toBase58();
}

export function freshSignature(): string {
  // A signature is 64 bytes base58; two concatenated pubkeys is the right
  // shape and length class for a fixture, and nothing under test parses it.
  return `${Keypair.generate().publicKey.toBase58()}${Keypair.generate().publicKey.toBase58()}`;
}

export const CAPABILITIES_FULL: WalletCapabilityRecord = {
  supportsSignAndSendTransactions: true,
  supportsSignTransactions: true,
  supportsSignMessages: true,
  preservesDurableNonce: true,
  walletLabel: 'fixture-wallet-full',
  rawCapabilities: { features: ['solana:signAndSendTransaction', 'solana:signTransactions'] },
  probedAtMs: 1_700_000_000_000,
};

/**
 * A wallet implementing only what MWA 2.0 makes mandatory.
 *
 * This is the capability set the guarantee must hold under, because
 * `signTransactions` is deprecated and a compliant wallet is free not to
 * offer it. Every verdict must be identical against this record.
 */
export const CAPABILITIES_MANDATORY_ONLY: WalletCapabilityRecord = {
  supportsSignAndSendTransactions: true,
  supportsSignTransactions: false,
  supportsSignMessages: false,
  preservesDurableNonce: true,
  walletLabel: 'fixture-wallet-mandatory-only',
  rawCapabilities: { features: ['solana:signAndSendTransaction'] },
  probedAtMs: 1_700_000_000_000,
};

export interface Scenario {
  readonly intent: IntentRecord;
  /** The base64 message of the transaction the intent describes. */
  readonly ourMessageBase64: string;
  /** A different, valid compiled message, for the foreign-consumer case. */
  readonly foreignMessageBase64: string;
  readonly buildSlot: number;
}

export function makeScenario(
  capabilities: WalletCapabilityRecord = CAPABILITIES_FULL,
  rawAmount = 20_000_000n,
): Scenario {
  const member = Keypair.generate().publicKey.toBase58();
  const source = Keypair.generate().publicKey.toBase58();
  const destination = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const noncePubkey = Keypair.generate().publicKey.toBase58();
  const nonceAuthority = Keypair.generate().publicKey.toBase58();
  const nonceValue = freshNonceValue();
  const circleId = 'thursday-circle';
  const roundIndex = 7;
  const buildSlot = 300_000;

  const { intent } = createIntentRecord({
    slotId: deriveSlotId(circleId, roundIndex, member),
    circleId,
    roundIndex,
    memberPubkey: member,
    sourceTokenAccount: source,
    destinationTokenAccount: destination,
    mint,
    mintDecimals: 6,
    rawAmount,
    noncePubkey,
    nonceAuthority,
    nonceValue,
    builtAtChainSlot: buildSlot,
    walletCapabilities: capabilities,
    createdAtMs: 1_700_000_001_000,
  });

  // A genuinely different transaction against the same nonce account: another
  // member paying a different vault. This is what F8 injects.
  const foreign = buildContributionTransaction({
    memberPubkey: Keypair.generate().publicKey.toBase58(),
    sourceTokenAccount: Keypair.generate().publicKey.toBase58(),
    destinationTokenAccount: Keypair.generate().publicKey.toBase58(),
    mint,
    mintDecimals: 6,
    rawAmount: 1n,
    noncePubkey,
    nonceAuthority,
    nonceValue,
  });

  return {
    intent,
    ourMessageBase64: intent.messageBase64,
    foreignMessageBase64: foreign.messageBase64,
    buildSlot,
  };
}

// ---------------------------------------------------------------------------
// Snapshot builders, one per row of the verdict table
// ---------------------------------------------------------------------------

interface SnapshotOptions {
  readonly observedAtSlot?: number;
  readonly firstAvailableSlot?: number | null;
}

function baseSnapshot(options: SnapshotOptions): Pick<
  ChainSnapshot,
  'observedAtSlot' | 'observedAtMs' | 'firstAvailableSlot'
> {
  return {
    observedAtSlot: options.observedAtSlot ?? 300_010,
    observedAtMs: 1_700_000_050_000,
    firstAvailableSlot: options.firstAvailableSlot ?? 1,
  };
}

/** Step 1: the nonce account does not exist. */
export function snapshotNonceGone(options: SnapshotOptions = {}): ChainSnapshot {
  return {
    nonceAccount: { exists: false },
    nonceSignatures: [],
    transactions: {},
    ...baseSnapshot(options),
  };
}

/** Step 1: the nonce is unchanged, so the transaction was never processed. */
export function snapshotNonceUnchanged(
  scenario: Scenario,
  options: SnapshotOptions = {},
): ChainSnapshot {
  return {
    nonceAccount: {
      exists: true,
      nonceValue: scenario.intent.nonceValueAtBuild,
      authority: scenario.intent.nonceAuthority,
      lamports: 1_447_680,
    },
    nonceSignatures: [],
    transactions: {},
    ...baseSnapshot(options),
  };
}

/** Step 2: the nonce advanced and no signature survives retention. */
export function snapshotAdvancedNoSignatures(
  scenario: Scenario,
  options: SnapshotOptions = {},
): ChainSnapshot {
  return {
    nonceAccount: {
      exists: true,
      nonceValue: freshNonceValue(),
      authority: scenario.intent.nonceAuthority,
      lamports: 1_447_680,
    },
    nonceSignatures: [],
    transactions: {},
    ...baseSnapshot(options),
  };
}

/** Step 2: a signature exists and the node will not return the transaction. */
export function snapshotTransactionUnavailable(
  scenario: Scenario,
  options: SnapshotOptions = {},
): ChainSnapshot {
  const signature = freshSignature();
  return {
    nonceAccount: {
      exists: true,
      nonceValue: freshNonceValue(),
      authority: scenario.intent.nonceAuthority,
      lamports: 1_447_680,
    },
    nonceSignatures: [entry(signature, scenario.buildSlot + 2, false)],
    transactions: { [signature]: { available: false } },
    ...baseSnapshot(options),
  };
}

/**
 * The nonce advanced and a transaction consumed it. One builder covers
 * `SETTLED`, `REJECTED`, `FOREIGN_CONSUMER`, and `BALANCE_DISAGREES`, because
 * those four differ only in the message, the error, and the delta — which is
 * exactly the point the verdict machine makes.
 */
export function snapshotConsumed(
  scenario: Scenario,
  consumed: {
    readonly messageBase64: string;
    readonly err: unknown;
    readonly destinationRawDelta: bigint | null;
    readonly logs?: readonly string[];
    readonly atSlot?: number;
  },
  options: SnapshotOptions = {},
): ChainSnapshot {
  const signature = freshSignature();
  const slot = consumed.atSlot ?? scenario.buildSlot + 3;
  const transaction: TransactionSnapshot = {
    available: true,
    signature,
    slot,
    messageBase64: consumed.messageBase64,
    err: consumed.err,
    logs: consumed.logs ?? [],
    destinationRawDelta: consumed.destinationRawDelta,
  };
  return {
    nonceAccount: {
      exists: true,
      nonceValue: freshNonceValue(),
      authority: scenario.intent.nonceAuthority,
      lamports: 1_447_680,
    },
    nonceSignatures: [entry(signature, slot, consumed.err !== null)],
    transactions: { [signature]: transaction },
    ...baseSnapshot(options),
  };
}

/** A clean settlement: our message, no error, exact delta. */
export function snapshotSettled(
  scenario: Scenario,
  options: SnapshotOptions = {},
): ChainSnapshot {
  return snapshotConsumed(
    scenario,
    {
      messageBase64: scenario.ourMessageBase64,
      err: null,
      destinationRawDelta: scenario.intent.transfer.expectedAmount,
      logs: ['Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success'],
    },
    options,
  );
}

/** Processed, instruction failed, nothing moved. The nonce still advanced. */
export function snapshotRejected(
  scenario: Scenario,
  options: SnapshotOptions = {},
): ChainSnapshot {
  return snapshotConsumed(
    scenario,
    {
      messageBase64: scenario.ourMessageBase64,
      err: { InstructionError: [1, { Custom: 1 }] },
      destinationRawDelta: 0n,
      logs: ['Program log: Error: insufficient funds'],
    },
    options,
  );
}

/** F8: a second signer advanced the nonce with an unrelated transaction. */
export function snapshotForeignConsumer(
  scenario: Scenario,
  options: SnapshotOptions = {},
): ChainSnapshot {
  return snapshotConsumed(
    scenario,
    {
      messageBase64: scenario.foreignMessageBase64,
      err: null,
      destinationRawDelta: null,
    },
    options,
  );
}

/** Our transaction succeeded and the destination gained the wrong amount. */
export function snapshotBalanceDisagrees(
  scenario: Scenario,
  options: SnapshotOptions = {},
): ChainSnapshot {
  return snapshotConsumed(
    scenario,
    {
      messageBase64: scenario.ourMessageBase64,
      err: null,
      destinationRawDelta: scenario.intent.transfer.expectedAmount - 1n,
    },
    options,
  );
}

/** Our transaction succeeded and the node returned no token balances. */
export function snapshotSettledUncorroborated(
  scenario: Scenario,
  options: SnapshotOptions = {},
): ChainSnapshot {
  return snapshotConsumed(
    scenario,
    {
      messageBase64: scenario.ourMessageBase64,
      err: null,
      destinationRawDelta: null,
    },
    options,
  );
}

function entry(signature: string, slot: number, hasError: boolean): SignatureEntry {
  return { signature, slot, hasError, blockTimeSec: 1_700_000_040 };
}

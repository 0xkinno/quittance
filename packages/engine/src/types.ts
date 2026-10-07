/**
 * Quittance domain types.
 *
 * One rule governs every type in this file:
 *
 *   The phone records intent. The chain decides truth. The phone is never
 *   allowed to be the authority on whether money moved.
 *
 * So an `IntentRecord` is a statement about what the phone meant to do, and a
 * `Verdict` is a statement about what the chain did. They are separate types
 * and no code path turns one into the other without a `ChainSnapshot`.
 */

/** A 32-byte public key, base58 encoded. */
export type Base58PublicKey = string;

/** A 64-byte transaction signature, base58 encoded. */
export type Base58Signature = string;

/** A sha256 digest, lowercase hex, 64 characters. */
export type Sha256Hex = string;

/** Raw token amount in the mint's smallest unit. Never a float. */
export type RawAmount = bigint;

// ---------------------------------------------------------------------------
// Contribution state
// ---------------------------------------------------------------------------

/**
 * The six states of a contribution slot. Four of them are terminal.
 *
 * `AMBIGUOUS` is terminal *for the machine*: the engine will never move it
 * on its own. Only a human decision recorded through the resolve path can
 * take a slot out of `AMBIGUOUS`, and that decision is itself evidence.
 */
export const CONTRIBUTION_STATES = [
  'DRAFTED',
  'IN_FLIGHT',
  'SETTLED',
  'REJECTED',
  'NOT_SENT',
  'AMBIGUOUS',
] as const;

export type ContributionState = (typeof CONTRIBUTION_STATES)[number];

/** States the engine will never move out of. */
export const TERMINAL_STATES = [
  'SETTLED',
  'REJECTED',
  'NOT_SENT',
  'AMBIGUOUS',
] as const satisfies readonly ContributionState[];

export type TerminalState = (typeof TERMINAL_STATES)[number];

export function isTerminal(state: ContributionState): state is TerminalState {
  return (TERMINAL_STATES as readonly ContributionState[]).includes(state);
}

/**
 * Every reason the engine can refuse to decide. There is no unnamed
 * ambiguity: a slot that escalates always carries one of these, and the
 * resolve screen renders the reason verbatim.
 *
 * The first four are the reasons enumerated by the verdict machine's five
 * resolution steps. `TRANSACTION_UNAVAILABLE` is the fifth, and it exists
 * because the alternative is guessing: the nonce has advanced, a signature
 * exists, and the node will not return the transaction, so the message hash
 * cannot be compared. Calling that settled would violate I2; calling it
 * not-sent would violate I1. It escalates.
 */
export const AMBIGUITY_REASONS = [
  /** The nonce account does not exist. It was closed, or never created. */
  'NONCE_ACCOUNT_GONE',
  /** The nonce advanced, but no signature survives in the node's retention window. */
  'BEYOND_RETENTION',
  /** A transaction consumed the nonce, and it is not the one that was recorded. */
  'FOREIGN_CONSUMER',
  /** The transaction succeeded, but the destination balance delta disagrees. */
  'BALANCE_DISAGREES',
  /** A signature exists and the node will not return the transaction. */
  'TRANSACTION_UNAVAILABLE',
] as const;

export type AmbiguityReason = (typeof AMBIGUITY_REASONS)[number];

// ---------------------------------------------------------------------------
// Intent — what the phone recorded, before the wallet was ever opened
// ---------------------------------------------------------------------------

/**
 * The transfer a contribution is supposed to effect. Separated from the
 * intent record so the verdict machine can compare it against chain state
 * without carrying any of the intent's bookkeeping.
 */
export interface TransferIntent {
  /** The member's wallet. */
  readonly expectedFrom: Base58PublicKey;
  /** The circle's vault token account. */
  readonly expectedTo: Base58PublicKey;
  /** The SPL mint being contributed. */
  readonly expectedMint: Base58PublicKey;
  /** Raw amount in the mint's smallest unit. */
  readonly expectedAmount: RawAmount;
  /** The mint's decimals, carried so a verdict renders without a lookup. */
  readonly mintDecimals: number;
}

/**
 * The write-ahead record. Persisted and flushed to durable storage *before*
 * `signAndSendTransactions` is called. Everything recovery needs is in here;
 * nothing recovery needs is anywhere else.
 */
export interface IntentRecord {
  /** Schema version, so a stored record from an older build is never misread. */
  readonly schemaVersion: 1;

  /** One contribution slot. One nonce account. One intent record. */
  readonly slotId: string;
  readonly circleId: string;
  readonly roundIndex: number;
  readonly memberPubkey: Base58PublicKey;

  /** The nonce account this intent is anchored to. */
  readonly noncePubkey: Base58PublicKey;
  /**
   * The nonce value the transaction was built against, base58. This is the
   * value that sits in the message's `recentBlockhash` field.
   *
   * The entire oracle is one comparison against this string.
   */
  readonly nonceValueAtBuild: string;
  /** The nonce account's authority, which must sign the first instruction. */
  readonly nonceAuthority: Base58PublicKey;

  /** sha256 of the compiled transaction message bytes. */
  readonly messageHash: Sha256Hex;
  /** The compiled message, base64. Present so recovery can rebroadcast. */
  readonly messageBase64: string;

  readonly transfer: TransferIntent;

  /**
   * The signed transaction bytes, base64, when and only when the wallet
   * implemented the optional `signTransactions` method and returned them.
   *
   * This is an optimization and nothing depends on it. Its absence must not
   * change any verdict. `test/verdict.unavailable.test.ts` forces the absent
   * path across the whole state table.
   */
  readonly signedTransactionBase64: string | null;

  /** What the wallet said it could do, recorded at session start. */
  readonly walletCapabilities: WalletCapabilityRecord;

  /** Milliseconds since the epoch, from the device clock, for ordering only. */
  readonly createdAtMs: number;
  /** The slot the nonce value was read at, for bounding the signature search. */
  readonly builtAtChainSlot: number;
}

// ---------------------------------------------------------------------------
// Wallet capabilities
// ---------------------------------------------------------------------------

/**
 * The result of probing the wallet at session start.
 *
 * Recorded with every intent so that a campaign row can be attributed to the
 * wallet behaviour that produced it, and so that a verdict can never be
 * explained away by "it probably supported a different method".
 */
export interface WalletCapabilityRecord {
  /** Mandatory under MWA 2.0. If false, the wallet is not usable. */
  readonly supportsSignAndSendTransactions: boolean;
  /** Deprecated under MWA 2.0. Used as an optimization when present. */
  readonly supportsSignTransactions: boolean;
  /** Deprecated under MWA 2.0. Never depended on. */
  readonly supportsSignMessages: boolean;
  /**
   * `true` only if a probe confirmed the wallet left a durable nonce value
   * intact in the message it broadcast. `null` means not yet probed, and the
   * engine will still build and send; it will not claim the probe passed.
   */
  readonly preservesDurableNonce: boolean | null;
  /** Identifier the wallet reported, for the evidence record. */
  readonly walletLabel: string;
  /** Raw `getCapabilities` payload, retained verbatim for the evidence log. */
  readonly rawCapabilities: Readonly<Record<string, unknown>>;
  readonly probedAtMs: number;
}

// ---------------------------------------------------------------------------
// Chain snapshot — the only input to the verdict machine besides the intent
// ---------------------------------------------------------------------------

/** The state of a nonce account as read from the chain. */
export type NonceAccountSnapshot =
  | { readonly exists: false }
  | {
      readonly exists: true;
      /** Current stored nonce value, base58. */
      readonly nonceValue: string;
      readonly authority: Base58PublicKey;
      readonly lamports: number;
    };

/** One entry from `getSignaturesForAddress`. */
export interface SignatureEntry {
  readonly signature: Base58Signature;
  readonly slot: number;
  /** `true` when the transaction carried an error. Mirrors the RPC field. */
  readonly hasError: boolean;
  readonly blockTimeSec: number | null;
}

/** The outcome of `getTransaction` for one signature. */
export type TransactionSnapshot =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly signature: Base58Signature;
      readonly slot: number;
      /** The compiled message bytes exactly as returned, base64. */
      readonly messageBase64: string;
      /** `null` means the transaction succeeded. */
      readonly err: unknown;
      /** Program logs, retained so a `REJECTED` verdict can say why. */
      readonly logs: readonly string[];
      /**
       * Observed raw delta on the expected destination token account, when
       * the node returned pre/post token balances. `null` when the node did
       * not supply them, which downgrades I2 corroboration rather than
       * fabricating it.
       */
      readonly destinationRawDelta: RawAmount | null;
    };

/**
 * Everything the verdict machine is allowed to look at.
 *
 * Assembled by `chain.ts`, which is the only module in the engine that
 * touches the network. The machine itself receives this plain object and is
 * therefore trivially testable and identical in the app and the verifier.
 */
export interface ChainSnapshot {
  readonly nonceAccount: NonceAccountSnapshot;
  /** Signatures touching the nonce account, newest first, as the RPC returns them. */
  readonly nonceSignatures: readonly SignatureEntry[];
  /** Keyed by signature. Only the candidates the machine asked about. */
  readonly transactions: Readonly<Record<Base58Signature, TransactionSnapshot>>;
  /** The slot the snapshot was taken at. */
  readonly observedAtSlot: number;
  readonly observedAtMs: number;
  /**
   * The oldest slot this node can serve signatures for, when known. Used to
   * distinguish "nothing happened" from "we cannot see that far back", which
   * is the difference between a terminal verdict and an escalation.
   */
  readonly firstAvailableSlot: number | null;
}

// ---------------------------------------------------------------------------
// Verdict — what the chain decided
// ---------------------------------------------------------------------------

export interface VerdictEvidence {
  /** The nonce value observed at resolution time, when the account existed. */
  readonly observedNonceValue: string | null;
  /** The signature that consumed the nonce, when one was identified. */
  readonly consumingSignature: Base58Signature | null;
  readonly consumingSlot: number | null;
  /** The message hash recomputed from chain data, when a transaction was fetched. */
  readonly observedMessageHash: Sha256Hex | null;
  readonly expectedMessageHash: Sha256Hex;
  readonly expectedRawAmount: RawAmount;
  readonly observedRawDelta: RawAmount | null;
  readonly programLogs: readonly string[];
  /** Mirrors the transaction's error field for a `REJECTED` verdict. */
  readonly transactionError: unknown;
}

export interface Verdict {
  readonly slotId: string;
  readonly state: ContributionState;
  /** Present exactly when `state === 'AMBIGUOUS'`. */
  readonly reason: AmbiguityReason | null;
  /** True when the engine will never revisit this verdict on its own. */
  readonly terminal: boolean;
  /**
   * True only for `NOT_SENT`, and it means one specific thing: the identical
   * recorded bytes may be rebroadcast. It never means "build a new one".
   */
  readonly safeToRebroadcastIdenticalBytes: boolean;
  readonly evidence: VerdictEvidence;
  /** Which resolution step produced this verdict. For the evidence log. */
  readonly decidedAtStep: 1 | 2 | 3 | 4 | 5;
  readonly decidedAtSlot: number;
  readonly decidedAtMs: number;
  /**
   * Whether the I2 balance corroboration actually ran and agreed.
   *
   * Only ever `true` on a `SETTLED` verdict that reached step 5 with a
   * destination delta present. When a node does not return token balances the
   * verdict is still `SETTLED` — the transaction is provably the recorded one
   * and provably succeeded — but this stays `false`, and the I2 predicate
   * counts it separately rather than as a clean pass. The machine does not
   * report a check that did not run.
   */
  readonly i2Corroborated: boolean;
}

// ---------------------------------------------------------------------------
// Human override — the only way out of AMBIGUOUS
// ---------------------------------------------------------------------------

export type HumanDecision = 'MARK_UNPAID_AND_REISSUE' | 'ACCEPT_AS_PAID';

/**
 * A recorded human decision on an ambiguous slot. Attributed and timestamped,
 * appended to the evidence log, and never collapsed into the verdict it
 * overrides: the verifier reports the machine verdict and the override
 * separately, so a reader can always see that a human intervened.
 */
export interface HumanOverride {
  readonly slotId: string;
  readonly decision: HumanDecision;
  /** The reason the machine escalated, carried forward verbatim. */
  readonly overriddenReason: AmbiguityReason;
  /** Who decided. The circle organizer's pubkey. */
  readonly decidedBy: Base58PublicKey;
  readonly decidedAtMs: number;
  /**
   * For `MARK_UNPAID_AND_REISSUE`: the signature of the advance that retired
   * the old nonce, so the old transaction provably can never land. The
   * reissue is not permitted to proceed until this is present.
   */
  readonly retiringAdvanceSignature: Base58Signature | null;
  readonly note: string;
}

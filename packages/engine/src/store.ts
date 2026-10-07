/**
 * The write-ahead intent store.
 *
 * The ordering constraint that makes everything else possible:
 *
 *   1. allocate a nonce account from the lease
 *   2. read its current nonce value N
 *   3. build the transaction: AdvanceNonceAccount first, then the transfer
 *   4. compute sha256 of the compiled message
 *   5. WRITE the intent record to durable storage and flush
 *   6. only now call signAndSendTransactions
 *
 * If the process dies at any point from step 5 onward, recovery has
 * everything it needs. If it dies before step 5, nothing was built and
 * nothing was sent, so there is nothing to recover.
 *
 * `putIntentDurably` is the step-5 boundary. It is the only write in the
 * system that must be synchronous and flushed before it returns, and the
 * implementation contract below says so in the terms an implementor needs.
 */

import { hashIntentRecord } from './canonical.ts';
import type {
  ContributionState,
  HumanOverride,
  IntentRecord,
  Verdict,
} from './types.ts';
import { isTerminal } from './types.ts';

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

/** An intent, its current state, and its latest verdict if it has one. */
export interface StoredSlot {
  readonly intent: IntentRecord;
  readonly state: ContributionState;
  /**
   * The tamper digest computed at write time. The verifier recomputes it from
   * the stored intent and reports a mismatch as an intent-hash failure,
   * separately from a verdict divergence, so a reader always knows which of
   * the two happened.
   */
  readonly intentHash: string;
  readonly verdict: Verdict | null;
  readonly override: HumanOverride | null;
  /** Append-only transition log for this slot, oldest first. */
  readonly transitions: readonly SlotTransition[];
}

export interface SlotTransition {
  readonly from: ContributionState;
  readonly to: ContributionState;
  readonly atMs: number;
  /** Why the state moved. Free text for the evidence log, never parsed. */
  readonly cause: string;
}

// ---------------------------------------------------------------------------
// The interface the app and the harness both implement
// ---------------------------------------------------------------------------

/**
 * The durable intent store.
 *
 * **Implementation contract.** `putIntentDurably` must not return until the
 * record is readable after an immediate process kill. On the device this means
 * a synchronous MMKV write; in the harness it means an `fsync`ed append. An
 * implementation that buffers this call in memory breaks the entire guarantee
 * and no verdict produced against it means anything.
 *
 * Every other method may be asynchronous and may buffer. Only step 5 is a
 * transaction boundary.
 */
export interface IntentStore {
  /**
   * Step 5. Persist a newly built intent in `DRAFTED` and flush.
   *
   * Rejects an attempt to overwrite an existing slot: one contribution slot
   * is written exactly once, and a second write would mean two live
   * transactions anchored to one nonce.
   */
  putIntentDurably(intent: IntentRecord): Promise<void>;

  /** Record that the intent has been handed to the wallet. */
  markInFlight(slotId: string, atMs: number): Promise<void>;

  /**
   * Apply a verdict. Refuses to move a slot out of a terminal state.
   */
  applyVerdict(verdict: Verdict): Promise<void>;

  /** Record a human decision on an ambiguous slot. */
  applyOverride(override: HumanOverride): Promise<void>;

  getSlot(slotId: string): Promise<StoredSlot | null>;

  /** Every slot, in insertion order. */
  listSlots(): Promise<readonly StoredSlot[]>;

  /**
   * Slots the resolver still has work to do on: `DRAFTED` and `IN_FLIGHT`.
   *
   * `AMBIGUOUS` is excluded deliberately. It is terminal for the machine and
   * returning it here would make the resolver churn forever on something only
   * a human can settle.
   */
  listNonTerminal(): Promise<readonly StoredSlot[]>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DuplicateSlotError extends Error {
  readonly slotId: string;

  constructor(slotId: string) {
    super(
      `Slot ${slotId} already has a persisted intent. Writing a second intent for one ` +
        'slot would anchor two live transactions to one nonce account.',
    );
    this.name = 'DuplicateSlotError';
    this.slotId = slotId;
  }
}

export class UnknownSlotError extends Error {
  readonly slotId: string;

  constructor(slotId: string) {
    super(`Slot ${slotId} has no persisted intent.`);
    this.name = 'UnknownSlotError';
    this.slotId = slotId;
  }
}

export class TerminalSlotError extends Error {
  readonly slotId: string;
  readonly state: ContributionState;

  constructor(slotId: string, state: ContributionState) {
    super(
      `Slot ${slotId} is terminal in state ${state}. Terminal states never move, and the ` +
        'store refuses the write rather than recording a regression.',
    );
    this.name = 'TerminalSlotError';
    this.slotId = slotId;
    this.state = state;
  }
}

// ---------------------------------------------------------------------------
// Reference implementation
// ---------------------------------------------------------------------------

/**
 * An in-memory store with the correct semantics.
 *
 * This is not a mock standing in for the real thing. It is the reference
 * implementation of the contract: the verifier, the unit tests, and the
 * harness's baseline arm all run against it, and the device implementation in
 * `app/src/storage` is tested for behavioural equivalence with it.
 *
 * It is `MemoryIntentStore` and not `MockIntentStore` for that reason.
 */
export class MemoryIntentStore implements IntentStore {
  private readonly slots = new Map<string, StoredSlot>();

  /**
   * Optional hook used by the crash-point tests. Called immediately before
   * each mutation commits, with the name of the step about to commit, so a
   * test can throw and simulate process death at an exact boundary.
   */
  private readonly beforeCommit: ((step: string) => void) | null;

  constructor(beforeCommit: ((step: string) => void) | null = null) {
    this.beforeCommit = beforeCommit;
  }

  private commit(step: string, slotId: string, next: StoredSlot): void {
    this.beforeCommit?.(step);
    this.slots.set(slotId, next);
  }

  private require(slotId: string): StoredSlot {
    const slot = this.slots.get(slotId);
    if (slot === undefined) throw new UnknownSlotError(slotId);
    return slot;
  }

  async putIntentDurably(intent: IntentRecord): Promise<void> {
    if (this.slots.has(intent.slotId)) throw new DuplicateSlotError(intent.slotId);
    this.commit('putIntentDurably', intent.slotId, {
      intent,
      state: 'DRAFTED',
      intentHash: hashIntentRecord(intent),
      verdict: null,
      override: null,
      transitions: [
        {
          from: 'DRAFTED',
          to: 'DRAFTED',
          atMs: intent.createdAtMs,
          cause: 'intent persisted before the wallet was invoked',
        },
      ],
    });
  }

  async markInFlight(slotId: string, atMs: number): Promise<void> {
    const slot = this.require(slotId);
    if (isTerminal(slot.state)) throw new TerminalSlotError(slotId, slot.state);
    if (slot.state === 'IN_FLIGHT') return;
    this.commit('markInFlight', slotId, {
      ...slot,
      state: 'IN_FLIGHT',
      transitions: [
        ...slot.transitions,
        { from: slot.state, to: 'IN_FLIGHT', atMs, cause: 'handed to the wallet over MWA' },
      ],
    });
  }

  async applyVerdict(verdict: Verdict): Promise<void> {
    const slot = this.require(verdict.slotId);
    if (isTerminal(slot.state)) {
      // Idempotent re-application of the same terminal state is a no-op, so
      // that running the resolver twice over one snapshot is safe.
      if (slot.state === verdict.state) return;
      throw new TerminalSlotError(verdict.slotId, slot.state);
    }
    this.commit('applyVerdict', verdict.slotId, {
      ...slot,
      state: verdict.state,
      verdict,
      transitions: [
        ...slot.transitions,
        {
          from: slot.state,
          to: verdict.state,
          atMs: verdict.decidedAtMs,
          cause: `verdict at step ${verdict.decidedAtStep}${
            verdict.reason === null ? '' : ` (${verdict.reason})`
          }`,
        },
      ],
    });
  }

  async applyOverride(override: HumanOverride): Promise<void> {
    const slot = this.require(override.slotId);
    if (slot.state !== 'AMBIGUOUS') {
      throw new Error(
        `Slot ${override.slotId} is in state ${slot.state}. A human override applies only to ` +
          'an ambiguous slot, because ambiguity is the only state a human is asked to decide.',
      );
    }
    if (
      override.decision === 'MARK_UNPAID_AND_REISSUE' &&
      override.retiringAdvanceSignature === null
    ) {
      throw new Error(
        `Slot ${override.slotId} cannot be reissued: no retiring advance signature was ` +
          'recorded. The old nonce must be provably advanced first, or the old transaction ' +
          'could still land alongside the replacement.',
      );
    }
    const next: ContributionState =
      override.decision === 'ACCEPT_AS_PAID' ? 'SETTLED' : 'NOT_SENT';
    this.commit('applyOverride', override.slotId, {
      ...slot,
      state: next,
      override,
      transitions: [
        ...slot.transitions,
        {
          from: 'AMBIGUOUS',
          to: next,
          atMs: override.decidedAtMs,
          cause: `human override ${override.decision} by ${override.decidedBy}`,
        },
      ],
    });
  }

  async getSlot(slotId: string): Promise<StoredSlot | null> {
    return this.slots.get(slotId) ?? null;
  }

  async listSlots(): Promise<readonly StoredSlot[]> {
    return [...this.slots.values()];
  }

  async listNonTerminal(): Promise<readonly StoredSlot[]> {
    return [...this.slots.values()].filter((slot) => !isTerminal(slot.state));
  }
}

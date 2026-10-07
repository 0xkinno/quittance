/**
 * The device implementation of the write-ahead intent store.
 *
 * `IntentStore.putIntentDurably` carries one hard requirement, and this file
 * exists to meet it:
 *
 *   **It must not return until the record survives an immediate process kill.**
 *
 * MMKV is used because its writes are synchronous and backed by `mmap` with
 * the page written through to the file before the call returns. There is no
 * JavaScript-side queue, no batching, and no `await` between the call and the
 * bytes being durable. An `AsyncStorage`-backed implementation would satisfy
 * the type and break the guarantee, because its write resolves on a promise
 * that Android is free to never schedule once the process is gone — and a
 * verdict produced against a store like that means nothing.
 *
 * `test/storage/equivalence.test.ts` runs this class and `MemoryIntentStore`
 * through the identical sequence and asserts they agree, so the reference
 * implementation the engine tests use is not quietly diverging from the one
 * that ships.
 */

import { MMKV } from 'react-native-mmkv';
import {
  hashIntentRecord,
  isTerminal,
  type ContributionState,
  type HumanOverride,
  type IntentRecord,
  type IntentStore,
  type SlotTransition,
  type StoredSlot,
  type Verdict,
  DuplicateSlotError,
  TerminalSlotError,
  UnknownSlotError,
} from '@quittance/engine';

/**
 * `bigint` does not survive `JSON.stringify`, and a `u64` token amount exceeds
 * the exact integer range of a double, so amounts are stored as decimal
 * strings and revived explicitly. Nothing in this file is permitted to be
 * lossy about an amount.
 */
interface PersistedSlot {
  readonly intent: Omit<IntentRecord, 'transfer'> & {
    readonly transfer: Omit<IntentRecord['transfer'], 'expectedAmount'> & {
      readonly expectedAmount: string;
    };
  };
  readonly state: ContributionState;
  readonly intentHash: string;
  readonly verdict: PersistedVerdict | null;
  readonly override: HumanOverride | null;
  readonly transitions: readonly SlotTransition[];
}

type PersistedVerdict = Omit<Verdict, 'evidence'> & {
  readonly evidence: Omit<
    Verdict['evidence'],
    'expectedRawAmount' | 'observedRawDelta'
  > & {
    readonly expectedRawAmount: string;
    readonly observedRawDelta: string | null;
  };
};

const SLOT_PREFIX = 'slot:';
const INDEX_KEY = 'slot-index';

export class MmkvIntentStore implements IntentStore {
  private readonly storage: MMKV;

  constructor(id = 'quittance.intents') {
    this.storage = new MMKV({ id });
  }

  // -------------------------------------------------------------------------
  // Step 5 — the transaction boundary
  // -------------------------------------------------------------------------

  async putIntentDurably(intent: IntentRecord): Promise<void> {
    if (this.storage.contains(SLOT_PREFIX + intent.slotId)) {
      throw new DuplicateSlotError(intent.slotId);
    }

    const slot: StoredSlot = {
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
    };

    // Order matters here. The slot record is written before the index entry,
    // so a kill between the two leaves a readable record that recovery can
    // still find by scanning keys — rather than an index pointing at a record
    // that was never written.
    this.storage.set(SLOT_PREFIX + intent.slotId, JSON.stringify(serialize(slot)));
    this.appendToIndex(intent.slotId);
  }

  async markInFlight(slotId: string, atMs: number): Promise<void> {
    const slot = this.require(slotId);
    if (isTerminal(slot.state)) throw new TerminalSlotError(slotId, slot.state);
    if (slot.state === 'IN_FLIGHT') return;

    this.write({
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
      if (slot.state === verdict.state) return;
      throw new TerminalSlotError(verdict.slotId, slot.state);
    }

    this.write({
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

    this.write({
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
    const raw = this.storage.getString(SLOT_PREFIX + slotId);
    return raw === undefined ? null : deserialize(JSON.parse(raw) as PersistedSlot);
  }

  async listSlots(): Promise<readonly StoredSlot[]> {
    return this.readIndex()
      .map((slotId) => this.storage.getString(SLOT_PREFIX + slotId))
      .filter((raw): raw is string => raw !== undefined)
      .map((raw) => deserialize(JSON.parse(raw) as PersistedSlot));
  }

  async listNonTerminal(): Promise<readonly StoredSlot[]> {
    return (await this.listSlots()).filter((slot) => !isTerminal(slot.state));
  }

  /**
   * Export every slot as the newline-delimited log the verifier reads.
   *
   * This is what makes the claim checkable by someone who does not have the
   * phone: the log plus a public RPC endpoint is everything the verifier
   * needs, and it recomputes each verdict with the same function that
   * produced it.
   */
  async exportIntentLog(): Promise<string> {
    const slots = await this.listSlots();
    return slots
      .map((slot) =>
        JSON.stringify({
          schemaVersion: 1,
          intent: serialize(slot).intent,
          intentHash: slot.intentHash,
          recordedState: slot.state,
          recordedVerdict: slot.verdict === null ? null : serializeVerdict(slot.verdict),
          recordedOverride: slot.override,
          campaignRunId: null,
          faultId: null,
          arm: 'quittance',
        }),
      )
      .join('\n');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private require(slotId: string): StoredSlot {
    const raw = this.storage.getString(SLOT_PREFIX + slotId);
    if (raw === undefined) throw new UnknownSlotError(slotId);
    return deserialize(JSON.parse(raw) as PersistedSlot);
  }

  private write(slot: StoredSlot): void {
    this.storage.set(SLOT_PREFIX + slot.intent.slotId, JSON.stringify(serialize(slot)));
  }

  private readIndex(): readonly string[] {
    const raw = this.storage.getString(INDEX_KEY);
    return raw === undefined ? [] : (JSON.parse(raw) as string[]);
  }

  private appendToIndex(slotId: string): void {
    const index = this.readIndex();
    if (index.includes(slotId)) return;
    this.storage.set(INDEX_KEY, JSON.stringify([...index, slotId]));
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serialize(slot: StoredSlot): PersistedSlot {
  return {
    intent: {
      ...slot.intent,
      transfer: {
        ...slot.intent.transfer,
        expectedAmount: slot.intent.transfer.expectedAmount.toString(10),
      },
    },
    state: slot.state,
    intentHash: slot.intentHash,
    verdict: slot.verdict === null ? null : serializeVerdict(slot.verdict),
    override: slot.override,
    transitions: slot.transitions,
  };
}

function serializeVerdict(verdict: Verdict): PersistedVerdict {
  return {
    ...verdict,
    evidence: {
      ...verdict.evidence,
      expectedRawAmount: verdict.evidence.expectedRawAmount.toString(10),
      observedRawDelta:
        verdict.evidence.observedRawDelta === null
          ? null
          : verdict.evidence.observedRawDelta.toString(10),
    },
  };
}

function deserialize(persisted: PersistedSlot): StoredSlot {
  return {
    intent: {
      ...persisted.intent,
      transfer: {
        ...persisted.intent.transfer,
        expectedAmount: BigInt(persisted.intent.transfer.expectedAmount),
      },
    },
    state: persisted.state,
    intentHash: persisted.intentHash,
    verdict:
      persisted.verdict === null
        ? null
        : {
            ...persisted.verdict,
            evidence: {
              ...persisted.verdict.evidence,
              expectedRawAmount: BigInt(persisted.verdict.evidence.expectedRawAmount),
              observedRawDelta:
                persisted.verdict.evidence.observedRawDelta === null
                  ? null
                  : BigInt(persisted.verdict.evidence.observedRawDelta),
            },
          },
    override: persisted.override,
    transitions: persisted.transitions,
  };
}

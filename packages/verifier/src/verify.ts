/**
 * The verification pass.
 *
 * This module imports the engine's verdict machine and its invariant
 * predicates and runs them. It does not reimplement them, and that is a
 * deliberate choice worth defending: two implementations that drift give you
 * an agreement test between two codebases, not a determinism test on one.
 *
 * What makes this an *independent* check is not a second implementation. It is
 * that the inputs are independent: the verifier re-reads the chain itself,
 * builds its own snapshots, recomputes the intent digests, and needs no app,
 * no wallet, no device, and no key. Given the same log, a stranger on another
 * machine reaches the same conclusions or the claim is false.
 *
 * Three failures are reported, and they are never pooled:
 *
 *   INTENT_HASH_FAILURE   the stored record was edited after it was written
 *   VERDICT_DIVERGENCE    the record is intact and the stored verdict is wrong
 *   INVARIANT_VIOLATION   a named invariant does not hold over the log
 */

import {
  captureSnapshot,
  checkById,
  digestsEqual,
  hashIntentRecord,
  resolveVerdict,
} from '@quittance/engine';
import type {
  ChainReader,
  ChainSnapshot,
  InvariantId,
  InvariantResult,
  RoundView,
  StoredSlot,
  Verdict,
} from '@quittance/engine';

import { deserializeIntent, deserializeVerdict } from './log.ts';
import type { IntentLogEntry } from './log.ts';

export type DivergenceKind = 'INTENT_HASH_FAILURE' | 'VERDICT_DIVERGENCE';

export interface Divergence {
  readonly kind: DivergenceKind;
  readonly slotId: string;
  readonly detail: string;
  readonly recorded: string;
  readonly recomputed: string;
}

export interface SlotVerification {
  readonly slotId: string;
  readonly arm: 'quittance' | 'baseline' | null;
  readonly faultId: string | null;
  readonly recordedState: string;
  readonly recomputedState: string;
  readonly recomputedReason: string | null;
  readonly agrees: boolean;
  /** Set when the chain could not be read for this slot. */
  readonly readError: string | null;
}

export interface VerificationReport {
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly rpcHost: string;
  readonly slotsRead: number;
  readonly slotsRecomputed: number;
  readonly slotsUnreadable: number;
  readonly divergences: readonly Divergence[];
  readonly invariants: readonly InvariantResult[];
  readonly slots: readonly SlotVerification[];
  /** `true` only when there are no divergences and every invariant passes. */
  readonly pass: boolean;
}

export interface VerifyOptions {
  readonly entries: readonly IntentLogEntry[];
  readonly reader: ChainReader;
  readonly rpcHost: string;
  readonly invariantIds: readonly InvariantId[];
  readonly rounds: readonly RoundView[];
  /** Restrict to one arm. Arms are reported separately, never pooled. */
  readonly arm: 'quittance' | 'baseline' | null;
  readonly onProgress?: ((slotId: string, index: number, total: number) => void) | undefined;
}

export async function verify(options: VerifyOptions): Promise<VerificationReport> {
  const startedAtMs = Date.now();

  const entries =
    options.arm === null
      ? options.entries
      : options.entries.filter((entry) => entry.arm === options.arm);

  const divergences: Divergence[] = [];
  const slots: SlotVerification[] = [];
  const storedSlots: StoredSlot[] = [];
  const snapshots = new Map<string, ChainSnapshot>();
  let unreadable = 0;
  let recomputed = 0;

  for (const [index, entry] of entries.entries()) {
    const intent = deserializeIntent(entry.intent);
    options.onProgress?.(intent.slotId, index + 1, entries.length);

    // --- the tamper test, first -------------------------------------------
    //
    // Run before anything is read from the chain. If the record was edited,
    // no verdict over it means anything, and spending RPC calls on it would
    // only produce a confident-looking second failure.
    const recomputedIntentHash = hashIntentRecord(intent);
    const intentIntact = digestsEqual(recomputedIntentHash, entry.intentHash);

    if (!intentIntact) {
      divergences.push({
        kind: 'INTENT_HASH_FAILURE',
        slotId: intent.slotId,
        detail:
          'The stored intent does not hash to the digest recorded when it was written. ' +
          'The record was edited after it was persisted.',
        recorded: entry.intentHash,
        recomputed: recomputedIntentHash,
      });
    }

    const storedVerdict: Verdict | null =
      entry.recordedVerdict === null ? null : deserializeVerdict(entry.recordedVerdict);

    storedSlots.push({
      intent,
      state: entry.recordedState,
      intentHash: entry.intentHash,
      verdict: storedVerdict,
      override: entry.recordedOverride,
      transitions: [],
    });

    if (!intentIntact) {
      slots.push({
        slotId: intent.slotId,
        arm: entry.arm,
        faultId: entry.faultId,
        recordedState: entry.recordedState,
        recomputedState: 'NOT RECOMPUTED',
        recomputedReason: null,
        agrees: false,
        readError: null,
      });
      continue;
    }

    // --- re-read the chain and recompute ----------------------------------

    let snapshot: ChainSnapshot;
    try {
      snapshot = await captureSnapshot(options.reader, intent);
    } catch (error) {
      unreadable += 1;
      slots.push({
        slotId: intent.slotId,
        arm: entry.arm,
        faultId: entry.faultId,
        recordedState: entry.recordedState,
        recomputedState: 'UNREADABLE',
        recomputedReason: null,
        agrees: false,
        readError: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    snapshots.set(intent.slotId, snapshot);
    const fresh = resolveVerdict(intent, snapshot);
    recomputed += 1;

    // A human override legitimately moves a slot out of the state the machine
    // reached. Comparing the recorded state against a fresh machine verdict
    // would then flag every honest override as a divergence, so the
    // comparison is against the recorded *machine* verdict, and the override
    // is reported on its own line by the I5 predicate.
    const comparisonTarget = storedVerdict;

    let agrees = true;
    if (comparisonTarget !== null) {
      const difference = describeDifference(comparisonTarget, fresh);
      if (difference !== null) {
        agrees = false;
        divergences.push({
          kind: 'VERDICT_DIVERGENCE',
          slotId: intent.slotId,
          detail: difference,
          recorded: `${comparisonTarget.state}${
            comparisonTarget.reason === null ? '' : `/${comparisonTarget.reason}`
          } at step ${comparisonTarget.decidedAtStep}`,
          recomputed: `${fresh.state}${fresh.reason === null ? '' : `/${fresh.reason}`} at step ${
            fresh.decidedAtStep
          }`,
        });
      }
    }

    slots.push({
      slotId: intent.slotId,
      arm: entry.arm,
      faultId: entry.faultId,
      recordedState: entry.recordedState,
      recomputedState: fresh.state,
      recomputedReason: fresh.reason,
      agrees,
      readError: null,
    });
  }

  const invariants = options.invariantIds.map((id) =>
    checkById(id, { slots: storedSlots, snapshots, rounds: options.rounds }),
  );

  const pass =
    divergences.length === 0 && invariants.every((result) => result.pass) && unreadable === 0;

  return {
    startedAtMs,
    finishedAtMs: Date.now(),
    rpcHost: options.rpcHost,
    slotsRead: entries.length,
    slotsRecomputed: recomputed,
    slotsUnreadable: unreadable,
    divergences,
    invariants,
    slots,
    pass,
  };
}

/**
 * Compare a recorded verdict against a freshly recomputed one.
 *
 * Only the decision is compared. The observation slot and timestamp
 * necessarily differ between the original run and the verification — the
 * verifier runs later, against a chain that has moved on — and treating those
 * as divergence would make the check fail on every honest reproduction.
 */
function describeDifference(recorded: Verdict, fresh: Verdict): string | null {
  if (recorded.state !== fresh.state) {
    return `recorded state ${recorded.state}, recomputed ${fresh.state}`;
  }
  if (recorded.reason !== fresh.reason) {
    return `recorded reason ${recorded.reason ?? 'none'}, recomputed ${fresh.reason ?? 'none'}`;
  }
  if (recorded.decidedAtStep !== fresh.decidedAtStep) {
    return `recorded step ${recorded.decidedAtStep}, recomputed ${fresh.decidedAtStep}`;
  }
  if (recorded.evidence.consumingSignature !== fresh.evidence.consumingSignature) {
    return (
      `recorded consuming signature ${recorded.evidence.consumingSignature ?? 'none'}, ` +
      `recomputed ${fresh.evidence.consumingSignature ?? 'none'}`
    );
  }
  if (recorded.evidence.observedMessageHash !== fresh.evidence.observedMessageHash) {
    return 'recorded and recomputed message hashes differ';
  }
  return null;
}

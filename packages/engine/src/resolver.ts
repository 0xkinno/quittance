/**
 * The resolver.
 *
 * Orchestration only: it fetches a snapshot, calls the pure verdict machine,
 * and writes the result. It contains no decision logic of its own, which is
 * deliberate — if the resolver could decide anything, the offline verifier
 * would no longer be recomputing the same thing the app computed.
 *
 * This is what runs behind the Recovering screen. A member who reopens the
 * app after a crash is watching this function, so it is written to answer in
 * one round trip in the common case and to keep going when one slot fails.
 */

import { captureSnapshot } from './chain.ts';
import type { ChainReader } from './chain.ts';
import { rebroadcast } from './broadcaster.ts';
import type { RawBroadcaster, RebroadcastOutcome, WalletBroadcaster } from './broadcaster.ts';
import type { IntentStore, StoredSlot } from './store.ts';
import type { IntentRecord, Verdict } from './types.ts';
import { isTerminal } from './types.ts';
import { assertNoRegression, resolveVerdict } from './verdict.ts';

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface SlotResolution {
  readonly slotId: string;
  readonly verdict: Verdict | null;
  /** Set when this slot could not be resolved at all. */
  readonly error: { readonly name: string; readonly message: string } | null;
  readonly rebroadcast: RebroadcastOutcome | null;
  readonly elapsedMs: number;
}

export interface ResolutionReport {
  readonly resolutions: readonly SlotResolution[];
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  /** Slots that reached a terminal state during this pass. */
  readonly settledCount: number;
  readonly rejectedCount: number;
  readonly notSentCount: number;
  readonly ambiguousCount: number;
  /** Slots that could not be resolved because a read failed. */
  readonly unresolvedCount: number;
}

export interface ResolveOptions {
  /**
   * Whether a `NOT_SENT` verdict should immediately rebroadcast the recorded
   * bytes.
   *
   * On the Recovering screen this is `true`: the member is present, the
   * payment was never processed, and the right thing is to finish what they
   * started rather than make them tap again. In the verifier it is `false`,
   * because a verifier must never change chain state.
   */
  readonly rebroadcastNotSent: boolean;
  readonly raw: RawBroadcaster | null;
  readonly wallet: WalletBroadcaster | null;
}

export const READ_ONLY_RESOLVE: ResolveOptions = {
  rebroadcastNotSent: false,
  raw: null,
  wallet: null,
};

// ---------------------------------------------------------------------------
// One slot
// ---------------------------------------------------------------------------

/**
 * Resolve a single intent and persist the verdict.
 *
 * The verdict is applied to the store before any rebroadcast is attempted.
 * That ordering matters: if the process dies during the rebroadcast, the next
 * pass reads a stored `NOT_SENT`, re-reads the nonce, and discovers whichever
 * outcome actually occurred. If the rebroadcast had gone first, a kill in
 * between would leave a transaction in flight with nothing on disk saying a
 * verdict had ever been reached.
 */
export async function resolveSlot(
  reader: ChainReader,
  store: IntentStore,
  intent: IntentRecord,
  currentState: StoredSlot['state'],
  options: ResolveOptions = READ_ONLY_RESOLVE,
): Promise<SlotResolution> {
  const startedAtMs = Date.now();

  try {
    const snapshot = await captureSnapshot(reader, intent);
    const verdict = resolveVerdict(intent, snapshot);

    assertNoRegression(intent.slotId, currentState, verdict.state);
    await store.applyVerdict(verdict);

    let rebroadcastOutcome: RebroadcastOutcome | null = null;
    if (verdict.state === 'NOT_SENT' && options.rebroadcastNotSent) {
      rebroadcastOutcome = await rebroadcast({
        intent,
        verdict,
        raw: options.raw,
        wallet: options.wallet,
      });
    }

    return {
      slotId: intent.slotId,
      verdict,
      error: null,
      rebroadcast: rebroadcastOutcome,
      elapsedMs: Date.now() - startedAtMs,
    };
  } catch (error) {
    // A read failure is not a verdict. The slot keeps the state it had, and
    // the screen says the network could not be reached — it never shows a
    // guess dressed up as an answer.
    return {
      slotId: intent.slotId,
      verdict: null,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
      rebroadcast: null,
      elapsedMs: Date.now() - startedAtMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Every outstanding slot
// ---------------------------------------------------------------------------

/**
 * Walk every non-terminal slot to a terminal state.
 *
 * Slots are resolved concurrently because they are independent: one nonce
 * account per slot means no two resolutions touch the same account, so there
 * is no ordering requirement between them and no benefit to serializing. This
 * is what keeps the Recovering screen inside its two-second budget when a
 * member has more than one payment outstanding.
 *
 * One slot failing does not stop the others. A member with three outstanding
 * contributions and one unreachable account should still be told about the
 * two that resolved.
 */
export async function resolveAllOutstanding(
  reader: ChainReader,
  store: IntentStore,
  options: ResolveOptions = READ_ONLY_RESOLVE,
): Promise<ResolutionReport> {
  const startedAtMs = Date.now();
  const outstanding = await store.listNonTerminal();

  const resolutions = await Promise.all(
    outstanding
      .filter((slot) => !isTerminal(slot.state))
      .map((slot) => resolveSlot(reader, store, slot.intent, slot.state, options)),
  );

  const count = (state: string): number =>
    resolutions.filter((resolution) => resolution.verdict?.state === state).length;

  return {
    resolutions,
    startedAtMs,
    finishedAtMs: Date.now(),
    settledCount: count('SETTLED'),
    rejectedCount: count('REJECTED'),
    notSentCount: count('NOT_SENT'),
    ambiguousCount: count('AMBIGUOUS'),
    unresolvedCount: resolutions.filter((resolution) => resolution.verdict === null).length,
  };
}

/**
 * Median time to a terminal verdict across a report, in milliseconds.
 *
 * The median rather than the mean, because a single unreachable account would
 * drag a mean into meaninglessness while telling a reader nothing about what
 * resolution normally costs. Reported alongside the count of unresolved slots
 * so neither number can hide the other.
 */
export function medianTimeToVerdictMs(report: ResolutionReport): number | null {
  const times = report.resolutions
    .filter((resolution) => resolution.verdict !== null && resolution.verdict.terminal)
    .map((resolution) => resolution.elapsedMs)
    .sort((a, b) => a - b);

  if (times.length === 0) return null;
  const middle = Math.floor(times.length / 2);
  if (times.length % 2 === 1) return times[middle] as number;
  return Math.round(((times[middle - 1] as number) + (times[middle] as number)) / 2);
}

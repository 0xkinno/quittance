/**
 * The six invariants, as independently callable predicates.
 *
 * Each one is checked twice: once here, by the code that commits state, and
 * once by the offline verifier, which recomputes from the exported intent log
 * plus chain state with no app and no wallet in the loop. The verifier imports
 * these exact functions — not a reimplementation of them — because two
 * implementations that drift are worse than one that is wrong.
 *
 *   I1  Exactly-once debit        a member is never debited twice for one slot
 *   I2  No phantom credit         SETTLED requires a hash-matched success and
 *                                 an agreeing balance delta
 *   I3  Terminal before payout    no disbursement while any slot is open
 *   I4  Single disbursement       a round pays out at most once, enforced on
 *                                 chain by the program
 *   I5  Honest ambiguity          a foreign consumer is never silently resolved
 *   I6  Offline determinism       every verdict is recomputable from the
 *                                 recorded intent plus chain state alone
 *
 * I1 and I4 are the two that must never fail under any fault. Everything else
 * supports them.
 *
 * Every predicate returns the evidence it used, not just a boolean. A check
 * that says only "false" cannot be put in front of a judge.
 */

import {
  digestsEqual,
  hashCompiledMessageBase64,
  hashIntentRecord,
} from './canonical.ts';
import type { StoredSlot } from './store.ts';
import type { Base58Signature, ChainSnapshot, IntentRecord, Verdict } from './types.ts';
import { isTerminal } from './types.ts';
import { resolveVerdict } from './verdict.ts';

export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6';

export interface InvariantViolation {
  readonly invariant: InvariantId;
  /** The slot or round the violation concerns. */
  readonly subject: string;
  readonly detail: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface InvariantResult {
  readonly invariant: InvariantId;
  readonly title: string;
  readonly pass: boolean;
  readonly checked: number;
  readonly violations: readonly InvariantViolation[];
  /**
   * Checks that could not be performed, with the reason. Reported separately
   * from violations: "we could not check this" and "this is broken" are
   * different claims and pooling them would overstate one and hide the other.
   */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// I1 — exactly-once debit
// ---------------------------------------------------------------------------

/**
 * A member is never debited twice for one contribution slot.
 *
 * Checked structurally rather than by counting transfers, because the
 * structure is what makes the double debit impossible:
 *
 *   a. one slot holds exactly one intent, so there is one nonce account and
 *      one message per slot;
 *   b. at most one transaction can ever consume a given nonce value, enforced
 *      by the runtime before execution (C2);
 *   c. therefore at most one transfer can exist per slot.
 *
 * The check verifies (a) and verifies that no slot's chain history shows two
 * distinct hash-matching consumers, which would falsify (b) and would mean
 * the runtime had not behaved as its source says it does.
 */
export function checkI1(
  slots: readonly StoredSlot[],
  snapshots: ReadonlyMap<string, ChainSnapshot>,
): InvariantResult {
  const violations: InvariantViolation[] = [];
  const notes: string[] = [];

  const byNonce = new Map<string, string[]>();
  for (const slot of slots) {
    const existing = byNonce.get(slot.intent.noncePubkey) ?? [];
    existing.push(slot.intent.slotId);
    byNonce.set(slot.intent.noncePubkey, existing);
  }

  for (const [noncePubkey, slotIds] of byNonce) {
    // Two *live* intents sharing a nonce account would be a real violation.
    // The lease recycles accounts between rounds on purpose, so sharing
    // across rounds is expected and correct: the account's nonce is advanced
    // between uses, which is precisely what makes reuse safe.
    const liveSlotIds = slotIds.filter((slotId) => {
      const slot = slots.find((candidate) => candidate.intent.slotId === slotId);
      return slot !== undefined && slot.state !== 'NOT_SENT' && !isRecycledEarlier(slot, slots);
    });
    if (liveSlotIds.length > 1) {
      violations.push({
        invariant: 'I1',
        subject: noncePubkey,
        detail:
          `Nonce account ${noncePubkey} is referenced by ${liveSlotIds.length} concurrently ` +
          'live contribution slots. One account anchoring two live transactions is the one ' +
          'way two transfers could both be valid.',
        evidence: { noncePubkey, slotIds: liveSlotIds },
      });
    }
  }

  for (const slot of slots) {
    const snapshot = snapshots.get(slot.intent.slotId);
    if (snapshot === undefined) {
      notes.push(
        `No chain snapshot for slot ${slot.intent.slotId}; its consumer count was not checked.`,
      );
      continue;
    }
    const matching = hashMatchingConsumers(slot.intent, snapshot);
    if (matching.length > 1) {
      violations.push({
        invariant: 'I1',
        subject: slot.intent.slotId,
        detail:
          `Slot ${slot.intent.slotId} has ${matching.length} confirmed transactions whose ` +
          'message hash matches the recorded intent. The runtime permits one consumer per ' +
          'nonce value, so this would mean the debit happened more than once.',
        evidence: { slotId: slot.intent.slotId, signatures: matching },
      });
    }
  }

  return {
    invariant: 'I1',
    title: 'Exactly-once debit',
    pass: violations.length === 0,
    checked: slots.length,
    violations,
    notes,
  };
}

function isRecycledEarlier(slot: StoredSlot, slots: readonly StoredSlot[]): boolean {
  return slots.some(
    (other) =>
      other.intent.noncePubkey === slot.intent.noncePubkey &&
      other.intent.slotId !== slot.intent.slotId &&
      other.intent.roundIndex < slot.intent.roundIndex,
  );
}

function hashMatchingConsumers(
  intent: IntentRecord,
  snapshot: ChainSnapshot,
): readonly Base58Signature[] {
  const matches: Base58Signature[] = [];
  for (const entry of snapshot.nonceSignatures) {
    const transaction = snapshot.transactions[entry.signature];
    if (transaction === undefined || !transaction.available) continue;
    if (transaction.err !== null && transaction.err !== undefined) continue;
    if (digestsEqual(hashCompiledMessageBase64(transaction.messageBase64), intent.messageHash)) {
      matches.push(entry.signature);
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// I2 — no phantom credit
// ---------------------------------------------------------------------------

/**
 * A slot is `SETTLED` only if a transaction matching the recorded message
 * hash confirmed with no error and the balance delta agrees.
 *
 * Uncorroborated settlements — where the node did not return token balances —
 * are counted in `notes`, not in `violations`. They are not phantom credits:
 * the transaction is provably the recorded one and provably succeeded. But the
 * second, independent check did not run, and saying so is the difference
 * between a verifier and a rubber stamp.
 */
export function checkI2(slots: readonly StoredSlot[]): InvariantResult {
  const violations: InvariantViolation[] = [];
  const notes: string[] = [];
  let checked = 0;

  for (const slot of slots) {
    if (slot.state !== 'SETTLED') continue;
    checked += 1;

    if (slot.override !== null && slot.override.decision === 'ACCEPT_AS_PAID') {
      // A human accepted an ambiguous slot as paid. That is permitted and it
      // is recorded, but it is never counted as a machine-verified
      // settlement, and the verifier surfaces it on its own line so nobody
      // reads a human decision as a chain fact.
      notes.push(
        `Slot ${slot.intent.slotId} is SETTLED by human override (${slot.override.decidedBy}), ` +
          `overriding ${slot.override.overriddenReason}. Not machine-verified.`,
      );
      continue;
    }

    const verdict = slot.verdict;
    if (verdict === null) {
      violations.push({
        invariant: 'I2',
        subject: slot.intent.slotId,
        detail: 'The slot is SETTLED and carries no verdict, so nothing supports the credit.',
        evidence: { slotId: slot.intent.slotId },
      });
      continue;
    }

    if (verdict.evidence.observedMessageHash === null) {
      violations.push({
        invariant: 'I2',
        subject: slot.intent.slotId,
        detail: 'SETTLED without a message hash recomputed from chain data.',
        evidence: { verdict },
      });
      continue;
    }

    if (!digestsEqual(verdict.evidence.observedMessageHash, slot.intent.messageHash)) {
      violations.push({
        invariant: 'I2',
        subject: slot.intent.slotId,
        detail:
          'SETTLED although the hash recomputed from chain data does not match the recorded ' +
          'intent. The credited transaction is not the transaction that was built.',
        evidence: {
          observed: verdict.evidence.observedMessageHash,
          expected: slot.intent.messageHash,
        },
      });
      continue;
    }

    if (verdict.evidence.transactionError !== null) {
      violations.push({
        invariant: 'I2',
        subject: slot.intent.slotId,
        detail: 'SETTLED although the transaction carried an error. This is a phantom credit.',
        evidence: { error: verdict.evidence.transactionError },
      });
      continue;
    }

    const delta = verdict.evidence.observedRawDelta;
    if (delta === null) {
      notes.push(
        `Slot ${slot.intent.slotId} is SETTLED on a hash-matched success, but the node did not ` +
          'return token balances, so the balance corroboration did not run.',
      );
      continue;
    }

    if (delta !== slot.intent.transfer.expectedAmount) {
      violations.push({
        invariant: 'I2',
        subject: slot.intent.slotId,
        detail:
          `SETTLED with a destination delta of ${delta} against an expected ` +
          `${slot.intent.transfer.expectedAmount}.`,
        evidence: { observed: delta.toString(), expected: slot.intent.transfer.expectedAmount.toString() },
      });
    }
  }

  return {
    invariant: 'I2',
    title: 'No phantom credit',
    pass: violations.length === 0,
    checked,
    violations,
    notes,
  };
}

// ---------------------------------------------------------------------------
// I3 — terminal before payout
// ---------------------------------------------------------------------------

export interface RoundView {
  readonly circleId: string;
  readonly roundIndex: number;
  readonly disbursed: boolean;
  /** Signatures of disbursements observed on chain for this round. */
  readonly disbursementSignatures: readonly Base58Signature[];
}

/**
 * A round cannot disburse while any contribution slot is non-terminal.
 *
 * Enforced on chain by the program as well. Checked here because the client
 * must not even offer the button, and because a verifier reading only chain
 * state should be able to confirm the ordering held in fact and not merely in
 * the program's intent.
 */
export function checkI3(
  slots: readonly StoredSlot[],
  rounds: readonly RoundView[],
): InvariantResult {
  const violations: InvariantViolation[] = [];
  let checked = 0;

  for (const round of rounds) {
    if (!round.disbursed) continue;
    checked += 1;
    const open = slots.filter(
      (slot) =>
        slot.intent.circleId === round.circleId &&
        slot.intent.roundIndex === round.roundIndex &&
        !isTerminal(slot.state),
    );
    if (open.length > 0) {
      violations.push({
        invariant: 'I3',
        subject: `${round.circleId}:${round.roundIndex}`,
        detail:
          `Round ${round.roundIndex} disbursed while ${open.length} contribution slots were ` +
          'still open. Paying out over an unresolved contribution is how a member ends up ' +
          'charged for a round that was already settled without them.',
        evidence: { openSlotIds: open.map((slot) => slot.intent.slotId) },
      });
    }
  }

  return {
    invariant: 'I3',
    title: 'Terminal before payout',
    pass: violations.length === 0,
    checked,
    violations,
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// I4 — single disbursement
// ---------------------------------------------------------------------------

/**
 * A round pays out at most once.
 *
 * Enforced on chain by the program, which checks and sets the disbursed flag
 * in one instruction so a second call cannot interleave. Checked here against
 * observed chain history, because the claim worth making is not "our program
 * has a flag" but "exactly one disbursement exists per round".
 */
export function checkI4(rounds: readonly RoundView[]): InvariantResult {
  const violations: InvariantViolation[] = [];

  for (const round of rounds) {
    if (round.disbursementSignatures.length > 1) {
      violations.push({
        invariant: 'I4',
        subject: `${round.circleId}:${round.roundIndex}`,
        detail:
          `Round ${round.roundIndex} has ${round.disbursementSignatures.length} disbursements ` +
          'on chain. The pot was paid out more than once.',
        evidence: { signatures: round.disbursementSignatures },
      });
    }
    if (round.disbursed && round.disbursementSignatures.length === 0) {
      violations.push({
        invariant: 'I4',
        subject: `${round.circleId}:${round.roundIndex}`,
        detail:
          `Round ${round.roundIndex} is flagged disbursed with no disbursement signature on ` +
          'chain. The flag and the history disagree.',
        evidence: { roundIndex: round.roundIndex },
      });
    }
  }

  return {
    invariant: 'I4',
    title: 'Single disbursement',
    pass: violations.length === 0,
    checked: rounds.length,
    violations,
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// I5 — honest ambiguity
// ---------------------------------------------------------------------------

/**
 * A nonce consumed by a non-matching transaction is never silently resolved.
 *
 * The failure this guards against is the tempting one: a slot whose nonce was
 * consumed by something unrecognised, quietly marked unpaid because unpaid is
 * the convenient answer. Every such slot must carry `FOREIGN_CONSUMER` and
 * must have escalated, and if a human resolved it the decision must be
 * attributed.
 */
export function checkI5(slots: readonly StoredSlot[]): InvariantResult {
  const violations: InvariantViolation[] = [];
  const notes: string[] = [];
  let checked = 0;

  for (const slot of slots) {
    const verdict = slot.verdict;
    if (verdict === null) continue;

    const observed = verdict.evidence.observedMessageHash;
    const consumed = verdict.evidence.consumingSignature !== null;
    if (!consumed || observed === null) continue;

    const matches = digestsEqual(observed, slot.intent.messageHash);
    if (matches) continue;

    checked += 1;

    if (verdict.state !== 'AMBIGUOUS' || verdict.reason !== 'FOREIGN_CONSUMER') {
      violations.push({
        invariant: 'I5',
        subject: slot.intent.slotId,
        detail:
          `Slot ${slot.intent.slotId} had its nonce consumed by a transaction that does not ` +
          `match the recorded intent, and it resolved to ${verdict.state} rather than ` +
          'escalating as FOREIGN_CONSUMER.',
        evidence: { verdict },
      });
      continue;
    }

    if (slot.state !== 'AMBIGUOUS' && slot.override === null) {
      violations.push({
        invariant: 'I5',
        subject: slot.intent.slotId,
        detail:
          `Slot ${slot.intent.slotId} escalated as FOREIGN_CONSUMER and then left AMBIGUOUS ` +
          `to ${slot.state} without a recorded human decision.`,
        evidence: { state: slot.state },
      });
      continue;
    }

    if (slot.override !== null) {
      notes.push(
        `Slot ${slot.intent.slotId} escalated as FOREIGN_CONSUMER and was resolved by ` +
          `${slot.override.decidedBy} as ${slot.override.decision}.`,
      );
    }
  }

  return {
    invariant: 'I5',
    title: 'Honest ambiguity',
    pass: violations.length === 0,
    checked,
    violations,
    notes,
  };
}

// ---------------------------------------------------------------------------
// I6 — offline determinism
// ---------------------------------------------------------------------------

/**
 * Every verdict is recomputable from the recorded intent plus chain state
 * alone, with no app, no wallet, and no model.
 *
 * Two distinct failures are reported separately, and keeping them separate is
 * the point of this check:
 *
 *   `INTENT_HASH_FAILURE`  the stored intent's canonical digest does not match
 *                          the digest recorded when it was written, so the
 *                          record was edited after the fact.
 *   `VERDICT_DIVERGENCE`   the intent is intact, and recomputing its verdict
 *                          from the snapshot produces a different answer than
 *                          the one stored.
 *
 * A verifier that collapsed these into one failure could not tell a reader
 * whether the data or the logic was wrong.
 */
export function checkI6(
  slots: readonly StoredSlot[],
  snapshots: ReadonlyMap<string, ChainSnapshot>,
): InvariantResult {
  const violations: InvariantViolation[] = [];
  const notes: string[] = [];
  let checked = 0;

  for (const slot of slots) {
    const recomputedIntentHash = hashIntentRecord(slot.intent);
    if (!digestsEqual(recomputedIntentHash, slot.intentHash)) {
      violations.push({
        invariant: 'I6',
        subject: slot.intent.slotId,
        detail:
          `INTENT_HASH_FAILURE: slot ${slot.intent.slotId}'s stored intent does not hash to ` +
          'the digest recorded when it was written. The record was edited after it was ' +
          'persisted, so no verdict over it can be trusted.',
        evidence: { recomputed: recomputedIntentHash, recorded: slot.intentHash },
      });
      continue;
    }

    const verdict = slot.verdict;
    const snapshot = snapshots.get(slot.intent.slotId);

    if (verdict === null) continue;
    if (snapshot === undefined) {
      notes.push(
        `No chain snapshot for slot ${slot.intent.slotId}; its verdict was not recomputed.`,
      );
      continue;
    }

    checked += 1;
    const recomputed = resolveVerdict(slot.intent, snapshot);
    const divergence = describeDivergence(verdict, recomputed);
    if (divergence !== null) {
      violations.push({
        invariant: 'I6',
        subject: slot.intent.slotId,
        detail: `VERDICT_DIVERGENCE: ${divergence}`,
        evidence: {
          stored: { state: verdict.state, reason: verdict.reason, step: verdict.decidedAtStep },
          recomputed: {
            state: recomputed.state,
            reason: recomputed.reason,
            step: recomputed.decidedAtStep,
          },
        },
      });
    }
  }

  return {
    invariant: 'I6',
    title: 'Offline determinism',
    pass: violations.length === 0,
    checked,
    violations,
    notes,
  };
}

/**
 * Compare a stored verdict against a recomputed one.
 *
 * Only the decision is compared — state, reason, step, and the consuming
 * signature. Observation timestamps and the observed slot necessarily differ
 * between the original run and the recomputation, and treating those as
 * divergence would make I6 fail for every honest verifier run.
 */
function describeDivergence(stored: Verdict, recomputed: Verdict): string | null {
  if (stored.state !== recomputed.state) {
    return `stored state ${stored.state}, recomputed ${recomputed.state}`;
  }
  if (stored.reason !== recomputed.reason) {
    return `stored reason ${stored.reason ?? 'none'}, recomputed ${recomputed.reason ?? 'none'}`;
  }
  if (stored.decidedAtStep !== recomputed.decidedAtStep) {
    return `stored step ${stored.decidedAtStep}, recomputed ${recomputed.decidedAtStep}`;
  }
  if (stored.evidence.consumingSignature !== recomputed.evidence.consumingSignature) {
    return (
      `stored consuming signature ${stored.evidence.consumingSignature ?? 'none'}, ` +
      `recomputed ${recomputed.evidence.consumingSignature ?? 'none'}`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// All six
// ---------------------------------------------------------------------------

export interface InvariantInputs {
  readonly slots: readonly StoredSlot[];
  readonly snapshots: ReadonlyMap<string, ChainSnapshot>;
  readonly rounds: readonly RoundView[];
}

export function checkAll(inputs: InvariantInputs): readonly InvariantResult[] {
  return [
    checkI1(inputs.slots, inputs.snapshots),
    checkI2(inputs.slots),
    checkI3(inputs.slots, inputs.rounds),
    checkI4(inputs.rounds),
    checkI5(inputs.slots),
    checkI6(inputs.slots, inputs.snapshots),
  ];
}

export function checkById(id: InvariantId, inputs: InvariantInputs): InvariantResult {
  switch (id) {
    case 'I1':
      return checkI1(inputs.slots, inputs.snapshots);
    case 'I2':
      return checkI2(inputs.slots);
    case 'I3':
      return checkI3(inputs.slots, inputs.rounds);
    case 'I4':
      return checkI4(inputs.rounds);
    case 'I5':
      return checkI5(inputs.slots);
    case 'I6':
      return checkI6(inputs.slots, inputs.snapshots);
  }
}

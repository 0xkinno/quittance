/**
 * The six invariants.
 *
 * Each one is tested twice over: once on a clean run, where it must pass, and
 * once against a deliberately corrupted store, where it must fail and must
 * name the right thing. A check that only ever passes has not been tested.
 *
 * The corrupted cases are constructed by hand rather than produced by the
 * engine, on purpose: they are states the engine refuses to create, and the
 * point of the verifier is to catch them if something else ever does.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hashIntentRecord } from '../src/canonical.ts';
import { checkAll, checkI1, checkI2, checkI3, checkI4, checkI5, checkI6 } from '../src/invariants.ts';
import type { RoundView } from '../src/invariants.ts';
import type { StoredSlot } from '../src/store.ts';
import type { ChainSnapshot, Verdict } from '../src/types.ts';
import { resolveVerdict } from '../src/verdict.ts';
import {
  makeScenario,
  snapshotForeignConsumer,
  snapshotNonceUnchanged,
  snapshotRejected,
  snapshotSettled,
  snapshotSettledUncorroborated,
} from './fixtures.ts';

type Scenario = ReturnType<typeof makeScenario>;

/** Build a stored slot the way the store would have, from a real verdict. */
function storedFrom(scenario: Scenario, snapshot: ChainSnapshot): StoredSlot {
  const verdict = resolveVerdict(scenario.intent, snapshot);
  return {
    intent: scenario.intent,
    state: verdict.state,
    intentHash: hashIntentRecord(scenario.intent),
    verdict,
    override: null,
    transitions: [],
  };
}

function snapshotMap(entries: ReadonlyArray<readonly [Scenario, ChainSnapshot]>) {
  return new Map(entries.map(([scenario, snapshot]) => [scenario.intent.slotId, snapshot]));
}

function round(overrides: Partial<RoundView> = {}): RoundView {
  return {
    circleId: 'thursday-circle',
    roundIndex: 7,
    disbursed: false,
    disbursementSignatures: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('I1 — exactly-once debit', () => {
  it('passes on a clean settled run', () => {
    const scenario = makeScenario();
    const snapshot = snapshotSettled(scenario);
    const result = checkI1([storedFrom(scenario, snapshot)], snapshotMap([[scenario, snapshot]]));

    assert.equal(result.pass, true);
    assert.deepEqual(result.violations, []);
  });

  it('fails when two live slots share one nonce account', () => {
    const first = makeScenario();
    const second = makeScenario();
    // Two slots in the same round pointed at one nonce account. This is the
    // only structural way two transfers could both be valid, so it must be
    // caught even though the engine's allocator cannot produce it.
    const shared: StoredSlot = {
      ...storedFrom(second, snapshotSettled(second)),
      intent: { ...second.intent, noncePubkey: first.intent.noncePubkey },
    };
    const slots = [storedFrom(first, snapshotSettled(first)), shared];

    const result = checkI1(slots, new Map());
    assert.equal(result.pass, false);
    assert.match(result.violations[0]?.detail ?? '', /concurrently\s+live/);
  });

  it('accepts one nonce account reused across different rounds', () => {
    const early = makeScenario();
    const later = makeScenario();
    const recycled: StoredSlot = {
      ...storedFrom(later, snapshotSettled(later)),
      intent: {
        ...later.intent,
        noncePubkey: early.intent.noncePubkey,
        roundIndex: early.intent.roundIndex + 1,
      },
    };

    // The lease recycles accounts between rounds by advancing them, which is
    // exactly what makes reuse safe. Flagging it would make the invariant
    // fire on correct behaviour.
    const result = checkI1([storedFrom(early, snapshotSettled(early)), recycled], new Map());
    assert.equal(result.pass, true);
  });

  it('fails if two confirmed transactions ever match one intent', () => {
    const scenario = makeScenario();
    const settled = snapshotSettled(scenario);
    const entry = settled.nonceSignatures[0];
    const transaction = entry === undefined ? undefined : settled.transactions[entry.signature];
    assert.ok(entry !== undefined && transaction !== undefined && transaction.available);

    // The same message confirmed twice. The runtime makes this impossible, so
    // observing it would mean the runtime had not behaved as its source says.
    const duplicated: ChainSnapshot = {
      ...settled,
      nonceSignatures: [...settled.nonceSignatures, { ...entry, signature: 'second-signature' }],
      transactions: {
        ...settled.transactions,
        'second-signature': { ...transaction, signature: 'second-signature' },
      },
    };

    const result = checkI1(
      [storedFrom(scenario, settled)],
      snapshotMap([[scenario, duplicated]]),
    );
    assert.equal(result.pass, false);
    assert.match(result.violations[0]?.detail ?? '', /message hash matches/);
  });

  it('records a note rather than a pass when a snapshot is missing', () => {
    const scenario = makeScenario();
    const result = checkI1([storedFrom(scenario, snapshotSettled(scenario))], new Map());
    // "We could not check this" and "this is fine" are different claims.
    assert.equal(result.pass, true);
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0] ?? '', /not checked/);
  });
});

describe('I2 — no phantom credit', () => {
  it('passes a corroborated settlement', () => {
    const scenario = makeScenario();
    const result = checkI2([storedFrom(scenario, snapshotSettled(scenario))]);
    assert.equal(result.pass, true);
    assert.equal(result.notes.length, 0);
  });

  it('notes an uncorroborated settlement instead of passing it silently', () => {
    const scenario = makeScenario();
    const result = checkI2([storedFrom(scenario, snapshotSettledUncorroborated(scenario))]);

    // Not a phantom credit: the transaction is provably ours and provably
    // succeeded. But the second check did not run, and the verifier says so.
    assert.equal(result.pass, true);
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0] ?? '', /corroboration did not run/);
  });

  it('ignores slots that are not settled', () => {
    const scenario = makeScenario();
    const result = checkI2([storedFrom(scenario, snapshotRejected(scenario))]);
    assert.equal(result.checked, 0);
    assert.equal(result.pass, true);
  });

  it('fails a settled slot carrying no verdict', () => {
    const scenario = makeScenario();
    const slot: StoredSlot = {
      intent: scenario.intent,
      state: 'SETTLED',
      intentHash: hashIntentRecord(scenario.intent),
      verdict: null,
      override: null,
      transitions: [],
    };
    const result = checkI2([slot]);
    assert.equal(result.pass, false);
    assert.match(result.violations[0]?.detail ?? '', /carries no verdict/);
  });

  it('fails a settled slot whose transaction carried an error', () => {
    const scenario = makeScenario();
    const rejected = storedFrom(scenario, snapshotRejected(scenario));
    const forged: StoredSlot = {
      ...rejected,
      state: 'SETTLED',
      verdict: { ...(rejected.verdict as Verdict), state: 'SETTLED' },
    };
    const result = checkI2([forged]);
    assert.equal(result.pass, false);
    assert.match(result.violations[0]?.detail ?? '', /phantom credit/);
  });

  it('fails a settled slot whose delta disagrees', () => {
    const scenario = makeScenario();
    const settled = storedFrom(scenario, snapshotSettled(scenario));
    const verdict = settled.verdict as Verdict;
    const forged: StoredSlot = {
      ...settled,
      verdict: { ...verdict, evidence: { ...verdict.evidence, observedRawDelta: 1n } },
    };
    const result = checkI2([forged]);
    assert.equal(result.pass, false);
    assert.match(result.violations[0]?.detail ?? '', /destination delta/);
  });

  it('never counts a human override as a machine-verified settlement', () => {
    const scenario = makeScenario();
    const ambiguous = storedFrom(scenario, snapshotForeignConsumer(scenario));
    const accepted: StoredSlot = {
      ...ambiguous,
      state: 'SETTLED',
      override: {
        slotId: scenario.intent.slotId,
        decision: 'ACCEPT_AS_PAID',
        overriddenReason: 'FOREIGN_CONSUMER',
        decidedBy: scenario.intent.nonceAuthority,
        decidedAtMs: 1_700_000_900_000,
        retiringAdvanceSignature: null,
        note: 'Confirmed by bank statement at collection.',
      },
    };

    const result = checkI2([accepted]);
    assert.equal(result.pass, true);
    assert.equal(result.checked, 1);
    assert.match(result.notes[0] ?? '', /human override/);
    assert.match(result.notes[0] ?? '', /Not machine-verified/);
  });
});

describe('I3 — terminal before payout', () => {
  it('passes when a disbursed round has only terminal slots', () => {
    const scenario = makeScenario();
    const slots = [storedFrom(scenario, snapshotSettled(scenario))];
    const result = checkI3(slots, [round({ disbursed: true, disbursementSignatures: ['s1'] })]);
    assert.equal(result.pass, true);
  });

  it('fails when a round disbursed over an open slot', () => {
    const scenario = makeScenario();
    const open: StoredSlot = {
      ...storedFrom(scenario, snapshotSettled(scenario)),
      state: 'IN_FLIGHT',
    };
    const result = checkI3([open], [round({ disbursed: true, disbursementSignatures: ['s1'] })]);
    assert.equal(result.pass, false);
    assert.match(result.violations[0]?.detail ?? '', /still open/);
  });

  it('ignores rounds that have not disbursed', () => {
    const scenario = makeScenario();
    const open: StoredSlot = {
      ...storedFrom(scenario, snapshotSettled(scenario)),
      state: 'IN_FLIGHT',
    };
    const result = checkI3([open], [round({ disbursed: false })]);
    assert.equal(result.pass, true);
    assert.equal(result.checked, 0);
  });
});

describe('I4 — single disbursement', () => {
  it('passes with exactly one disbursement', () => {
    const result = checkI4([round({ disbursed: true, disbursementSignatures: ['s1'] })]);
    assert.equal(result.pass, true);
  });

  it('fails with two disbursements on one round', () => {
    const result = checkI4([round({ disbursed: true, disbursementSignatures: ['s1', 's2'] })]);
    assert.equal(result.pass, false);
    assert.match(result.violations[0]?.detail ?? '', /paid out more than once/);
  });

  it('fails when the flag claims a disbursement the chain does not show', () => {
    const result = checkI4([round({ disbursed: true, disbursementSignatures: [] })]);
    assert.equal(result.pass, false);
    assert.match(result.violations[0]?.detail ?? '', /flag and the history disagree/);
  });
});

describe('I5 — honest ambiguity', () => {
  it('passes when a foreign consumer escalated as it must', () => {
    const scenario = makeScenario();
    const result = checkI5([storedFrom(scenario, snapshotForeignConsumer(scenario))]);
    assert.equal(result.pass, true);
    assert.equal(result.checked, 1);
  });

  it('fails when a foreign consumer was quietly resolved as unpaid', () => {
    const scenario = makeScenario();
    const escalated = storedFrom(scenario, snapshotForeignConsumer(scenario));
    const verdict = escalated.verdict as Verdict;
    // The tempting failure: mark it unpaid because unpaid is convenient.
    const silenced: StoredSlot = {
      ...escalated,
      state: 'NOT_SENT',
      verdict: { ...verdict, state: 'NOT_SENT', reason: null },
    };
    const result = checkI5([silenced]);
    assert.equal(result.pass, false);
    assert.match(result.violations[0]?.detail ?? '', /rather than\s+escalating/);
  });

  it('fails when a slot left AMBIGUOUS with no recorded human decision', () => {
    const scenario = makeScenario();
    const escalated = storedFrom(scenario, snapshotForeignConsumer(scenario));
    const drifted: StoredSlot = { ...escalated, state: 'SETTLED', override: null };
    const result = checkI5([drifted]);
    assert.equal(result.pass, false);
    assert.match(result.violations[0]?.detail ?? '', /without a recorded human decision/);
  });

  it('attributes a human resolution in its notes', () => {
    const scenario = makeScenario();
    const escalated = storedFrom(scenario, snapshotForeignConsumer(scenario));
    const resolved: StoredSlot = {
      ...escalated,
      state: 'NOT_SENT',
      override: {
        slotId: scenario.intent.slotId,
        decision: 'MARK_UNPAID_AND_REISSUE',
        overriddenReason: 'FOREIGN_CONSUMER',
        decidedBy: scenario.intent.nonceAuthority,
        decidedAtMs: 1_700_000_900_000,
        retiringAdvanceSignature: 'advance-signature',
        note: 'Nonce retired before reissue.',
      },
    };
    const result = checkI5([resolved]);
    assert.equal(result.pass, true);
    assert.match(result.notes[0] ?? '', /MARK_UNPAID_AND_REISSUE/);
  });
});

describe('I6 — offline determinism', () => {
  it('recomputes a clean run to the same verdict', () => {
    const scenario = makeScenario();
    const snapshot = snapshotSettled(scenario);
    const result = checkI6([storedFrom(scenario, snapshot)], snapshotMap([[scenario, snapshot]]));
    assert.equal(result.pass, true);
    assert.equal(result.checked, 1);
  });

  it('reports INTENT_HASH_FAILURE when the stored intent was edited', () => {
    const scenario = makeScenario();
    const snapshot = snapshotSettled(scenario);
    const slot = storedFrom(scenario, snapshot);
    const tampered: StoredSlot = {
      ...slot,
      intent: { ...slot.intent, transfer: { ...slot.intent.transfer, expectedAmount: 1n } },
    };

    const result = checkI6([tampered], snapshotMap([[scenario, snapshot]]));
    assert.equal(result.pass, false);
    assert.match(result.violations[0]?.detail ?? '', /INTENT_HASH_FAILURE/);
    // Editing the data must never be reported as the logic diverging.
    assert.ok(!(result.violations[0]?.detail ?? '').includes('VERDICT_DIVERGENCE'));
  });

  it('reports VERDICT_DIVERGENCE when a stored verdict was edited', () => {
    const scenario = makeScenario();
    const snapshot = snapshotSettled(scenario);
    const slot = storedFrom(scenario, snapshot);
    const verdict = slot.verdict as Verdict;
    const forged: StoredSlot = {
      ...slot,
      state: 'NOT_SENT',
      verdict: { ...verdict, state: 'NOT_SENT', decidedAtStep: 1 },
    };

    const result = checkI6([forged], snapshotMap([[scenario, snapshot]]));
    assert.equal(result.pass, false);
    assert.match(result.violations[0]?.detail ?? '', /VERDICT_DIVERGENCE/);
    // And editing the verdict must never be reported as the intent being
    // tampered with. The two failures stay distinguishable.
    assert.ok(!(result.violations[0]?.detail ?? '').includes('INTENT_HASH_FAILURE'));
  });

  it('does not treat differing observation timestamps as divergence', () => {
    const scenario = makeScenario();
    const snapshot = snapshotSettled(scenario);
    const slot = storedFrom(scenario, snapshot);

    // A verifier run always observes at a different slot and time than the
    // original. If that counted as divergence, I6 would fail on every honest
    // reproduction, which would make it worthless.
    const later: ChainSnapshot = {
      ...snapshot,
      observedAtSlot: snapshot.observedAtSlot + 5_000,
      observedAtMs: snapshot.observedAtMs + 600_000,
    };

    const result = checkI6([slot], snapshotMap([[scenario, later]]));
    assert.equal(result.pass, true);
  });
});

describe('all six together', () => {
  it('passes a clean multi-slot round', () => {
    const settled = makeScenario();
    const rejected = makeScenario();
    const unsent = makeScenario();

    const settledSnapshot = snapshotSettled(settled);
    const rejectedSnapshot = snapshotRejected(rejected);
    const unsentSnapshot = snapshotNonceUnchanged(unsent);

    const results = checkAll({
      slots: [
        storedFrom(settled, settledSnapshot),
        storedFrom(rejected, rejectedSnapshot),
        storedFrom(unsent, unsentSnapshot),
      ],
      snapshots: snapshotMap([
        [settled, settledSnapshot],
        [rejected, rejectedSnapshot],
        [unsent, unsentSnapshot],
      ]),
      rounds: [round({ disbursed: true, disbursementSignatures: ['payout-signature'] })],
    });

    assert.equal(results.length, 6);
    for (const result of results) {
      assert.equal(result.pass, true, `${result.invariant} failed: ${JSON.stringify(result.violations)}`);
    }
  });
});

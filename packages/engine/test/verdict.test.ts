/**
 * The verdict table.
 *
 * Every reachable outcome of the machine, one case each, against synthetic
 * chain snapshots. No network, no device, no wallet. The whole file is
 * required to run in well under a second so it can sit in front of every
 * commit rather than in a nightly job.
 *
 * `DRAFTED` and `IN_FLIGHT` are absent deliberately: they are states the
 * store holds, never verdicts the machine returns. A test asserting the
 * machine can return them would be asserting a bug.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveVerdict, TerminalRegressionError, assertNoRegression } from '../src/verdict.ts';
import { AMBIGUITY_REASONS } from '../src/types.ts';
import {
  makeScenario,
  snapshotAdvancedNoSignatures,
  snapshotBalanceDisagrees,
  snapshotForeignConsumer,
  snapshotNonceGone,
  snapshotNonceUnchanged,
  snapshotRejected,
  snapshotSettled,
  snapshotSettledUncorroborated,
  snapshotTransactionUnavailable,
} from './fixtures.ts';

describe('the verdict machine — terminal outcomes', () => {
  it('NOT_SENT when the nonce still holds the value the transaction was built against', () => {
    const scenario = makeScenario();
    const verdict = resolveVerdict(scenario.intent, snapshotNonceUnchanged(scenario));

    assert.equal(verdict.state, 'NOT_SENT');
    assert.equal(verdict.reason, null);
    assert.equal(verdict.terminal, true);
    assert.equal(verdict.decidedAtStep, 1);
    // The one verdict that authorizes resending, and the only one.
    assert.equal(verdict.safeToRebroadcastIdenticalBytes, true);
    assert.equal(verdict.evidence.observedNonceValue, scenario.intent.nonceValueAtBuild);
  });

  it('SETTLED when our message confirmed with no error and the delta agrees', () => {
    const scenario = makeScenario();
    const verdict = resolveVerdict(scenario.intent, snapshotSettled(scenario));

    assert.equal(verdict.state, 'SETTLED');
    assert.equal(verdict.reason, null);
    assert.equal(verdict.terminal, true);
    assert.equal(verdict.decidedAtStep, 5);
    assert.equal(verdict.i2Corroborated, true);
    assert.equal(verdict.safeToRebroadcastIdenticalBytes, false);
    assert.equal(verdict.evidence.observedMessageHash, scenario.intent.messageHash);
    assert.equal(verdict.evidence.observedRawDelta, scenario.intent.transfer.expectedAmount);
  });

  it('SETTLED but uncorroborated when the node returned no token balances', () => {
    const scenario = makeScenario();
    const verdict = resolveVerdict(scenario.intent, snapshotSettledUncorroborated(scenario));

    assert.equal(verdict.state, 'SETTLED');
    // The transaction is provably ours and provably succeeded, so the verdict
    // stands. The second check did not run, and the machine says so rather
    // than reporting a pass it did not earn.
    assert.equal(verdict.i2Corroborated, false);
    assert.equal(verdict.evidence.observedRawDelta, null);
  });

  it('REJECTED when our message was processed and the instruction failed', () => {
    const scenario = makeScenario();
    const verdict = resolveVerdict(scenario.intent, snapshotRejected(scenario));

    // The nonce advanced, so a naive design would call this paid. It is not
    // paid: the runtime rolls the accounts back and then stores the advanced
    // nonce anyway, to stop replay of a failed nonce transaction.
    assert.equal(verdict.state, 'REJECTED');
    assert.equal(verdict.reason, null);
    assert.equal(verdict.terminal, true);
    assert.equal(verdict.decidedAtStep, 4);
    assert.equal(verdict.safeToRebroadcastIdenticalBytes, false);
    assert.deepEqual(verdict.evidence.transactionError, { InstructionError: [1, { Custom: 1 }] });
    assert.ok(verdict.evidence.programLogs.length > 0);
  });
});

describe('the verdict machine — every ambiguity reason', () => {
  it('NONCE_ACCOUNT_GONE when the nonce account does not exist', () => {
    const scenario = makeScenario();
    const verdict = resolveVerdict(scenario.intent, snapshotNonceGone());

    assert.equal(verdict.state, 'AMBIGUOUS');
    assert.equal(verdict.reason, 'NONCE_ACCOUNT_GONE');
    assert.equal(verdict.decidedAtStep, 1);
    assert.equal(verdict.terminal, true);
  });

  it('BEYOND_RETENTION when the nonce advanced and no signature survives', () => {
    const scenario = makeScenario();
    const verdict = resolveVerdict(scenario.intent, snapshotAdvancedNoSignatures(scenario));

    assert.equal(verdict.state, 'AMBIGUOUS');
    assert.equal(verdict.reason, 'BEYOND_RETENTION');
    assert.equal(verdict.decidedAtStep, 2);
  });

  it('TRANSACTION_UNAVAILABLE when a signature exists and the node will not return it', () => {
    const scenario = makeScenario();
    const verdict = resolveVerdict(scenario.intent, snapshotTransactionUnavailable(scenario));

    assert.equal(verdict.state, 'AMBIGUOUS');
    assert.equal(verdict.reason, 'TRANSACTION_UNAVAILABLE');
    assert.equal(verdict.decidedAtStep, 2);
    // The signature is carried forward so the resolve screen can link it.
    assert.ok(verdict.evidence.consumingSignature !== null);
  });

  it('FOREIGN_CONSUMER when something else consumed the nonce', () => {
    const scenario = makeScenario();
    const verdict = resolveVerdict(scenario.intent, snapshotForeignConsumer(scenario));

    assert.equal(verdict.state, 'AMBIGUOUS');
    assert.equal(verdict.reason, 'FOREIGN_CONSUMER');
    assert.equal(verdict.decidedAtStep, 3);
    assert.ok(verdict.evidence.observedMessageHash !== null);
    assert.notEqual(verdict.evidence.observedMessageHash, scenario.intent.messageHash);
    // It must never be resolved as paid or as unpaid, in either direction.
    assert.equal(verdict.safeToRebroadcastIdenticalBytes, false);
  });

  it('BALANCE_DISAGREES when our transaction succeeded with the wrong delta', () => {
    const scenario = makeScenario();
    const verdict = resolveVerdict(scenario.intent, snapshotBalanceDisagrees(scenario));

    assert.equal(verdict.state, 'AMBIGUOUS');
    assert.equal(verdict.reason, 'BALANCE_DISAGREES');
    assert.equal(verdict.decidedAtStep, 5);
    assert.equal(
      verdict.evidence.observedRawDelta,
      scenario.intent.transfer.expectedAmount - 1n,
    );
  });

  it('covers every declared ambiguity reason — no reason is unreachable', () => {
    const scenario = makeScenario();
    const produced = new Set(
      [
        snapshotNonceGone(),
        snapshotAdvancedNoSignatures(scenario),
        snapshotTransactionUnavailable(scenario),
        snapshotForeignConsumer(scenario),
        snapshotBalanceDisagrees(scenario),
      ]
        .map((snapshot) => resolveVerdict(scenario.intent, snapshot).reason)
        .filter((reason): reason is string => reason !== null),
    );

    // An enumerated reason that no snapshot can produce is dead code
    // pretending to be rigour, so the enum and the table must agree exactly.
    assert.deepEqual([...produced].sort(), [...AMBIGUITY_REASONS].sort());
  });
});

describe('the verdict machine — purity and determinism', () => {
  it('returns an identical decision for an identical snapshot', () => {
    const scenario = makeScenario();
    const snapshot = snapshotSettled(scenario);

    const first = resolveVerdict(scenario.intent, snapshot);
    const second = resolveVerdict(scenario.intent, snapshot);

    assert.deepEqual(first, second);
  });

  it('never mutates the intent or the snapshot it was given', () => {
    const scenario = makeScenario();
    const snapshot = snapshotSettled(scenario);
    const intentBefore = JSON.stringify(scenario.intent, bigintReplacer);
    const snapshotBefore = JSON.stringify(snapshot, bigintReplacer);

    resolveVerdict(scenario.intent, snapshot);

    assert.equal(JSON.stringify(scenario.intent, bigintReplacer), intentBefore);
    assert.equal(JSON.stringify(snapshot, bigintReplacer), snapshotBefore);
  });

  it('identifies our transaction even when a later unrelated signature exists', () => {
    const scenario = makeScenario();
    const settled = snapshotSettled(scenario);
    const foreign = snapshotForeignConsumer(scenario);

    // Both signatures are present on the account, ours first. The machine
    // must pick the one whose message hash matches, not merely the newest.
    const merged = {
      ...settled,
      nonceSignatures: [...foreign.nonceSignatures, ...settled.nonceSignatures],
      transactions: { ...foreign.transactions, ...settled.transactions },
    };

    const verdict = resolveVerdict(scenario.intent, merged);
    assert.equal(verdict.state, 'SETTLED');
    assert.equal(verdict.evidence.observedMessageHash, scenario.intent.messageHash);
  });

  it('ignores signatures from before the nonce value was read', () => {
    const scenario = makeScenario();
    const stale = snapshotConsumedBefore(scenario);

    // Those signatures were already reflected in the nonce read, so they
    // cannot be the consumer of the value we built against. With nothing in
    // range, the honest answer is that the consumer is not visible.
    const verdict = resolveVerdict(scenario.intent, stale);
    assert.equal(verdict.state, 'AMBIGUOUS');
    assert.equal(verdict.reason, 'BEYOND_RETENTION');
  });
});

describe('terminal states never move backwards', () => {
  it('permits a non-terminal slot to take any verdict', () => {
    assert.doesNotThrow(() => assertNoRegression('slot', 'IN_FLIGHT', 'SETTLED'));
    assert.doesNotThrow(() => assertNoRegression('slot', 'DRAFTED', 'NOT_SENT'));
  });

  it('permits re-asserting the same terminal state, so resolving twice is safe', () => {
    assert.doesNotThrow(() => assertNoRegression('slot', 'SETTLED', 'SETTLED'));
  });

  it('refuses to move a terminal slot to a different state', () => {
    assert.throws(
      () => assertNoRegression('slot', 'SETTLED', 'NOT_SENT'),
      TerminalRegressionError,
    );
    assert.throws(
      () => assertNoRegression('slot', 'REJECTED', 'SETTLED'),
      TerminalRegressionError,
    );
  });
});

function snapshotConsumedBefore(scenario: ReturnType<typeof makeScenario>) {
  const snapshot = snapshotSettled(scenario);
  return {
    ...snapshot,
    nonceSignatures: snapshot.nonceSignatures.map((entry) => ({
      ...entry,
      slot: scenario.buildSlot - 5,
    })),
  };
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

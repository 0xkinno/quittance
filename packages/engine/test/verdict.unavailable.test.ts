/**
 * The guarantee under a wallet that implements only what MWA 2.0 requires.
 *
 * `signTransactions` is deprecated by the MWA 2.0 spec. A compliant wallet may
 * drop it entirely, so the guarantee must not depend on it in any way. The
 * exact-byte rebroadcast it enables is an optimization that saves a wallet
 * round trip; it is not what makes anything safe.
 *
 * This file forces the unavailable path across the whole verdict table and
 * asserts, decision by decision, that every outcome is byte-identical to the
 * outcome under a wallet that offers everything. If this file ever diverges,
 * the project is quietly depending on an optional method and the headline
 * claim is false.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canRebroadcastExactBytes, isUsableForContributions } from '../src/capabilities.ts';
import { withSignedBytes } from '../src/intent.ts';
import { rebroadcast } from '../src/broadcaster.ts';
import { resolveVerdict } from '../src/verdict.ts';
import type { ChainSnapshot } from '../src/types.ts';
import {
  CAPABILITIES_FULL,
  CAPABILITIES_MANDATORY_ONLY,
  makeScenario,
  snapshotAdvancedNoSignatures,
  snapshotBalanceDisagrees,
  snapshotForeignConsumer,
  snapshotNonceGone,
  snapshotNonceUnchanged,
  snapshotRejected,
  snapshotSettled,
  snapshotTransactionUnavailable,
} from './fixtures.ts';

type SnapshotFactory = (scenario: ReturnType<typeof makeScenario>) => ChainSnapshot;

const TABLE: ReadonlyArray<readonly [string, SnapshotFactory]> = [
  ['NOT_SENT', (scenario) => snapshotNonceUnchanged(scenario)],
  ['SETTLED', (scenario) => snapshotSettled(scenario)],
  ['REJECTED', (scenario) => snapshotRejected(scenario)],
  ['NONCE_ACCOUNT_GONE', () => snapshotNonceGone()],
  ['BEYOND_RETENTION', (scenario) => snapshotAdvancedNoSignatures(scenario)],
  ['TRANSACTION_UNAVAILABLE', (scenario) => snapshotTransactionUnavailable(scenario)],
  ['FOREIGN_CONSUMER', (scenario) => snapshotForeignConsumer(scenario)],
  ['BALANCE_DISAGREES', (scenario) => snapshotBalanceDisagrees(scenario)],
];

describe('every verdict is identical without signTransactions', () => {
  it('reports the capability honestly', () => {
    assert.equal(isUsableForContributions(CAPABILITIES_MANDATORY_ONLY), true);
    assert.equal(canRebroadcastExactBytes(CAPABILITIES_MANDATORY_ONLY), false);
    assert.equal(canRebroadcastExactBytes(CAPABILITIES_FULL), true);
  });

  for (const [label, factory] of TABLE) {
    it(`${label} resolves the same way on a mandatory-only wallet`, () => {
      // Two scenarios differing only in the capability record. Every other
      // input — amount, mint, round, build slot — is held identical so the
      // comparison isolates the capability.
      const full = makeScenario(CAPABILITIES_FULL);
      const limited = makeScenario(CAPABILITIES_MANDATORY_ONLY);

      const fullVerdict = resolveVerdict(full.intent, factory(full));
      const limitedVerdict = resolveVerdict(limited.intent, factory(limited));

      assert.equal(limitedVerdict.state, fullVerdict.state);
      assert.equal(limitedVerdict.reason, fullVerdict.reason);
      assert.equal(limitedVerdict.terminal, fullVerdict.terminal);
      assert.equal(limitedVerdict.decidedAtStep, fullVerdict.decidedAtStep);
      assert.equal(
        limitedVerdict.safeToRebroadcastIdenticalBytes,
        fullVerdict.safeToRebroadcastIdenticalBytes,
      );
      assert.equal(limitedVerdict.i2Corroborated, fullVerdict.i2Corroborated);
    });
  }

  it('refuses to record signed bytes for a wallet that did not offer the method', () => {
    const limited = makeScenario(CAPABILITIES_MANDATORY_ONLY);
    // Recording bytes against a wallet whose probe said it cannot produce them
    // would misattribute the evidence, so it throws rather than storing a
    // field the campaign record would then misreport.
    assert.throws(
      () => withSignedBytes(limited.intent, 'AAAA'),
      /capability probe did not report/,
    );
  });
});

describe('rebroadcast on a mandatory-only wallet', () => {
  it('falls back to the wallet path and still succeeds', async () => {
    const scenario = makeScenario(CAPABILITIES_MANDATORY_ONLY);
    const verdict = resolveVerdict(scenario.intent, snapshotNonceUnchanged(scenario));
    assert.equal(verdict.state, 'NOT_SENT');
    assert.equal(scenario.intent.signedTransactionBase64, null);

    let walletCalls = 0;
    const outcome = await rebroadcast({
      intent: scenario.intent,
      verdict,
      raw: null,
      wallet: {
        signAndSend: async () => {
          walletCalls += 1;
          return 'signature-from-wallet';
        },
      },
    });

    assert.equal(outcome.kind, 'ACCEPTED');
    assert.equal(walletCalls, 1);
  });

  it('counts a runtime drop as the duplicate being refused, not as a failure', async () => {
    const scenario = makeScenario(CAPABILITIES_MANDATORY_ONLY);
    const verdict = resolveVerdict(scenario.intent, snapshotNonceUnchanged(scenario));

    const outcome = await rebroadcast({
      intent: scenario.intent,
      verdict,
      raw: null,
      wallet: {
        signAndSend: async () => {
          // What the cluster says once the nonce has advanced.
          throw new Error('failed to send transaction: Blockhash not found');
        },
      },
      retryPolicy: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    });

    assert.equal(outcome.kind, 'DROPPED_BY_RUNTIME');
  });

  it('refuses to rebroadcast anything that is not NOT_SENT', async () => {
    const scenario = makeScenario(CAPABILITIES_MANDATORY_ONLY);
    const settled = resolveVerdict(scenario.intent, snapshotSettled(scenario));

    const outcome = await rebroadcast({
      intent: scenario.intent,
      verdict: settled,
      raw: null,
      wallet: {
        signAndSend: async () => {
          assert.fail('a settled slot must never reach the broadcaster');
        },
      },
    });

    assert.equal(outcome.kind, 'NOT_PERMITTED');
  });
});

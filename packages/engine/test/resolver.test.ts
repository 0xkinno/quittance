/**
 * The resolver.
 *
 * What runs behind the Recovering screen. These tests use a stub
 * `ChainReader` rather than a network, which is the point of having the
 * reader be an interface: the fault harness injects a fault-injecting reader
 * for F6 through the same seam.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ChainReadError, withRetry } from '../src/chain.ts';
import type { ChainReader } from '../src/chain.ts';
import { medianTimeToVerdictMs, resolveAllOutstanding, resolveSlot } from '../src/resolver.ts';
import { MemoryIntentStore } from '../src/store.ts';
import type {
  Base58Signature,
  ChainSnapshot,
  NonceAccountSnapshot,
  SignatureEntry,
  TransactionSnapshot,
} from '../src/types.ts';
import {
  makeScenario,
  snapshotForeignConsumer,
  snapshotNonceUnchanged,
  snapshotRejected,
  snapshotSettled,
} from './fixtures.ts';

/**
 * A reader that serves a prepared snapshot.
 *
 * It counts its own calls, so the tests can assert that the fast path really
 * is fast — an unchanged nonce must cost one account read and no signature
 * or transaction reads at all, which is what keeps the Recovering screen
 * inside its budget.
 */
class StubReader implements ChainReader {
  accountReads = 0;
  signatureReads = 0;
  transactionReads = 0;

  private readonly snapshot: ChainSnapshot;
  private readonly failAccountRead: boolean;

  constructor(snapshot: ChainSnapshot, failAccountRead = false) {
    this.snapshot = snapshot;
    this.failAccountRead = failAccountRead;
  }

  async readNonceAccount(): Promise<NonceAccountSnapshot> {
    this.accountReads += 1;
    if (this.failAccountRead) throw new ChainReadError(4, new Error('socket hang up'));
    return this.snapshot.nonceAccount;
  }

  async readNonceSignatures(): Promise<readonly SignatureEntry[]> {
    this.signatureReads += 1;
    return this.snapshot.nonceSignatures;
  }

  async readTransaction(signature: Base58Signature): Promise<TransactionSnapshot> {
    this.transactionReads += 1;
    return this.snapshot.transactions[signature] ?? { available: false };
  }

  async readCurrentSlot(): Promise<number> {
    return this.snapshot.observedAtSlot;
  }

  async readFirstAvailableSlot(): Promise<number | null> {
    return this.snapshot.firstAvailableSlot;
  }
}

describe('resolving one slot', () => {
  it('reads one account and stops when the nonce is unchanged', async () => {
    const scenario = makeScenario();
    const store = new MemoryIntentStore();
    await store.putIntentDurably(scenario.intent);
    await store.markInFlight(scenario.intent.slotId, 1);

    const reader = new StubReader(snapshotNonceUnchanged(scenario));
    const resolution = await resolveSlot(reader, store, scenario.intent, 'IN_FLIGHT');

    assert.equal(resolution.verdict?.state, 'NOT_SENT');
    assert.equal(reader.accountReads, 1);
    // The common recovery case costs one account read. No signature scan, no
    // transaction fetch. This is why the screen resolves quickly.
    assert.equal(reader.signatureReads, 0);
    assert.equal(reader.transactionReads, 0);
  });

  it('persists the verdict it reached', async () => {
    const scenario = makeScenario();
    const store = new MemoryIntentStore();
    await store.putIntentDurably(scenario.intent);
    await store.markInFlight(scenario.intent.slotId, 1);

    const reader = new StubReader(snapshotSettled(scenario));
    await resolveSlot(reader, store, scenario.intent, 'IN_FLIGHT');

    const slot = await store.getSlot(scenario.intent.slotId);
    assert.equal(slot?.state, 'SETTLED');
    assert.equal(slot?.verdict?.state, 'SETTLED');
    assert.deepEqual(
      slot?.transitions.map((transition) => transition.to),
      ['DRAFTED', 'IN_FLIGHT', 'SETTLED'],
    );
  });

  it('is idempotent — resolving twice leaves the same store', async () => {
    const scenario = makeScenario();
    const store = new MemoryIntentStore();
    await store.putIntentDurably(scenario.intent);
    await store.markInFlight(scenario.intent.slotId, 1);

    const reader = new StubReader(snapshotSettled(scenario));
    await resolveSlot(reader, store, scenario.intent, 'IN_FLIGHT');
    const after = await store.getSlot(scenario.intent.slotId);

    // A second pass over a terminal slot must be a no-op, which is what makes
    // being killed mid-resolve cost nothing but a retry.
    const second = await resolveSlot(reader, store, scenario.intent, 'SETTLED');
    assert.equal(second.verdict?.state, 'SETTLED');
    assert.deepEqual(await store.getSlot(scenario.intent.slotId), after);
  });

  it('reports a read failure without inventing a verdict', async () => {
    const scenario = makeScenario();
    const store = new MemoryIntentStore();
    await store.putIntentDurably(scenario.intent);
    await store.markInFlight(scenario.intent.slotId, 1);

    const reader = new StubReader(snapshotSettled(scenario), true);
    const resolution = await resolveSlot(reader, store, scenario.intent, 'IN_FLIGHT');

    assert.equal(resolution.verdict, null);
    assert.equal(resolution.error?.name, 'ChainReadError');
    // The slot keeps the state it had. A screen that cannot reach the network
    // says so; it never shows a guess dressed up as an answer.
    assert.equal((await store.getSlot(scenario.intent.slotId))?.state, 'IN_FLIGHT');
  });

  it('does not rebroadcast in read-only mode, even on NOT_SENT', async () => {
    const scenario = makeScenario();
    const store = new MemoryIntentStore();
    await store.putIntentDurably(scenario.intent);

    const reader = new StubReader(snapshotNonceUnchanged(scenario));
    const resolution = await resolveSlot(reader, store, scenario.intent, 'DRAFTED');

    assert.equal(resolution.verdict?.state, 'NOT_SENT');
    // A verifier must never change chain state, so the default is read-only.
    assert.equal(resolution.rebroadcast, null);
  });

  it('rebroadcasts on NOT_SENT when the member is present', async () => {
    const scenario = makeScenario();
    const store = new MemoryIntentStore();
    await store.putIntentDurably(scenario.intent);

    const reader = new StubReader(snapshotNonceUnchanged(scenario));
    let sent = 0;
    const resolution = await resolveSlot(reader, store, scenario.intent, 'DRAFTED', {
      rebroadcastNotSent: true,
      raw: null,
      wallet: {
        signAndSend: async () => {
          sent += 1;
          return 'resend-signature';
        },
      },
    });

    assert.equal(resolution.rebroadcast?.kind, 'ACCEPTED');
    assert.equal(sent, 1);
  });

  it('applies the verdict before attempting any rebroadcast', async () => {
    const scenario = makeScenario();
    const order: string[] = [];
    const store = new MemoryIntentStore((step) => order.push(step));

    await store.putIntentDurably(scenario.intent);
    const reader = new StubReader(snapshotNonceUnchanged(scenario));

    await resolveSlot(reader, store, scenario.intent, 'DRAFTED', {
      rebroadcastNotSent: true,
      raw: null,
      wallet: {
        signAndSend: async () => {
          order.push('signAndSend');
          return 'resend-signature';
        },
      },
    });

    // If the rebroadcast went first, a kill in between would leave a
    // transaction in flight with nothing on disk saying a verdict was reached.
    assert.deepEqual(order, ['putIntentDurably', 'applyVerdict', 'signAndSend']);
  });
});

describe('resolving every outstanding slot', () => {
  it('resolves independent slots and tallies them by state', async () => {
    const settled = makeScenario();
    const rejected = makeScenario();
    const unsent = makeScenario();
    const foreign = makeScenario();

    const snapshots = new Map<string, ChainSnapshot>([
      [settled.intent.noncePubkey, snapshotSettled(settled)],
      [rejected.intent.noncePubkey, snapshotRejected(rejected)],
      [unsent.intent.noncePubkey, snapshotNonceUnchanged(unsent)],
      [foreign.intent.noncePubkey, snapshotForeignConsumer(foreign)],
    ]);

    const reader: ChainReader = {
      readNonceAccount: async (noncePubkey) =>
        (snapshots.get(noncePubkey) as ChainSnapshot).nonceAccount,
      readNonceSignatures: async (noncePubkey) =>
        (snapshots.get(noncePubkey) as ChainSnapshot).nonceSignatures,
      readTransaction: async (signature) => {
        for (const snapshot of snapshots.values()) {
          const transaction = snapshot.transactions[signature];
          if (transaction !== undefined) return transaction;
        }
        return { available: false };
      },
      readCurrentSlot: async () => 300_010,
      readFirstAvailableSlot: async () => 1,
    };

    const store = new MemoryIntentStore();
    for (const scenario of [settled, rejected, unsent, foreign]) {
      await store.putIntentDurably(scenario.intent);
      await store.markInFlight(scenario.intent.slotId, 1);
    }

    const report = await resolveAllOutstanding(reader, store);

    assert.equal(report.settledCount, 1);
    assert.equal(report.rejectedCount, 1);
    assert.equal(report.notSentCount, 1);
    assert.equal(report.ambiguousCount, 1);
    assert.equal(report.unresolvedCount, 0);
    assert.equal((await store.listNonTerminal()).length, 0);
  });

  it('keeps resolving the others when one slot fails', async () => {
    const healthy = makeScenario();
    const broken = makeScenario();
    const healthySnapshot = snapshotSettled(healthy);

    const reader: ChainReader = {
      readNonceAccount: async (noncePubkey) => {
        if (noncePubkey === broken.intent.noncePubkey) {
          throw new ChainReadError(4, new Error('ETIMEDOUT'));
        }
        return healthySnapshot.nonceAccount;
      },
      readNonceSignatures: async () => healthySnapshot.nonceSignatures,
      readTransaction: async (signature) =>
        healthySnapshot.transactions[signature] ?? { available: false },
      readCurrentSlot: async () => 300_010,
      readFirstAvailableSlot: async () => 1,
    };

    const store = new MemoryIntentStore();
    for (const scenario of [healthy, broken]) {
      await store.putIntentDurably(scenario.intent);
      await store.markInFlight(scenario.intent.slotId, 1);
    }

    const report = await resolveAllOutstanding(reader, store);

    // A member with two outstanding contributions and one unreachable account
    // should still be told about the one that resolved.
    assert.equal(report.settledCount, 1);
    assert.equal(report.unresolvedCount, 1);
  });

  it('excludes ambiguous slots from later passes', async () => {
    const foreign = makeScenario();
    const snapshot = snapshotForeignConsumer(foreign);
    const reader = new StubReader(snapshot);

    const store = new MemoryIntentStore();
    await store.putIntentDurably(foreign.intent);
    await store.markInFlight(foreign.intent.slotId, 1);

    await resolveAllOutstanding(reader, store);
    assert.equal((await store.getSlot(foreign.intent.slotId))?.state, 'AMBIGUOUS');

    // Ambiguity is terminal for the machine. Returning it to the resolver
    // would make it churn forever on something only a human can settle.
    const second = await resolveAllOutstanding(reader, store);
    assert.equal(second.resolutions.length, 0);
  });

  it('reports the median time to a terminal verdict, and null when there is none', async () => {
    const scenario = makeScenario();
    const store = new MemoryIntentStore();
    await store.putIntentDurably(scenario.intent);

    const reader = new StubReader(snapshotSettled(scenario));
    const report = await resolveAllOutstanding(reader, store);
    const median = medianTimeToVerdictMs(report);

    assert.ok(median !== null && median >= 0);
    assert.equal(
      medianTimeToVerdictMs({ ...report, resolutions: [] }),
      null,
    );
  });
});

describe('bounded retry', () => {
  it('succeeds on a later attempt', async () => {
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('transient');
        return 'ok';
      },
      { attempts: 4, baseDelayMs: 0, maxDelayMs: 0 },
      async () => {},
      () => 0,
    );
    assert.equal(value, 'ok');
    assert.equal(calls, 3);
  });

  it('gives up after the bound and says so rather than hanging', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw new Error('down');
          },
          { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
          async () => {},
          () => 0,
        ),
      ChainReadError,
    );
    // Bounded on purpose: a screen that never answers is worse than one that
    // says the network could not be reached.
    assert.equal(calls, 3);
  });
});

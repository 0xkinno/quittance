/**
 * Crash points.
 *
 * The write-ahead ordering is the thing that makes recovery possible, so it
 * is tested by killing the process between every pair of adjacent steps and
 * asserting that what survives on disk is sufficient — or that nothing was
 * sent, which is equally safe.
 *
 *   step 1  allocate a nonce account from the lease
 *   step 2  read its current nonce value N
 *   step 3  build the transaction, AdvanceNonceAccount first
 *   step 4  compute sha256 of the compiled message
 *   step 5  WRITE the intent record and flush        <- the boundary
 *   step 6  call signAndSendTransactions
 *
 * The invariant being tested: a kill before step 5 leaves nothing on chain
 * and nothing on disk. A kill at or after step 5 leaves enough on disk to
 * resolve whatever happened on chain. There is no window where a transaction
 * can exist that the store cannot describe.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertPersistedBeforeSend, IntentNotPersistedError } from '../src/broadcaster.ts';
import { createIntentRecord, deriveSlotId } from '../src/intent.ts';
import { allocate, releaseUnconsumed } from '../src/nonce-lease.ts';
import type { LeaseState } from '../src/nonce-lease.ts';
import { DuplicateSlotError, MemoryIntentStore } from '../src/store.ts';
import { CAPABILITIES_FULL, freshNonceValue, makeScenario } from './fixtures.ts';
import { Keypair } from '@solana/web3.js';

/** A process kill, raised at an instrumented boundary. */
class SimulatedProcessDeath extends Error {
  constructor(step: string) {
    super(`simulated process death at ${step}`);
    this.name = 'SimulatedProcessDeath';
  }
}

function makeLease(): LeaseState {
  const authority = Keypair.generate().publicKey.toBase58();
  return {
    circleId: 'thursday-circle',
    payment: {
      paidBy: authority,
      paymentSignature: null,
      skrMint: Keypair.generate().publicKey.toBase58(),
      paidRawAmount: 1_000_000_000n,
      mintIsGenuineSkr: false,
      entitledAccountCount: 13,
    },
    accounts: Array.from({ length: 13 }, () => ({
      pubkey: Keypair.generate().publicKey.toBase58(),
      authority,
      state: 'AVAILABLE' as const,
      heldBySlotId: null,
      lastAdvancedAtChainSlot: 299_000,
      timesRecycled: 0,
      retiredReason: null,
    })),
  };
}

describe('the write-ahead boundary', () => {
  it('step 5 completes before the wallet can be called', async () => {
    const scenario = makeScenario();
    const store = new MemoryIntentStore();

    // Before the durable write, the send is refused outright. This is the
    // whole ordering constraint, enforced rather than documented.
    assert.throws(
      () => assertPersistedBeforeSend(scenario.intent, false),
      IntentNotPersistedError,
    );

    await store.putIntentDurably(scenario.intent);
    assert.doesNotThrow(() => assertPersistedBeforeSend(scenario.intent, true));
  });

  it('a kill between step 4 and step 5 leaves nothing on disk and nothing sent', async () => {
    const scenario = makeScenario();
    const store = new MemoryIntentStore((step) => {
      if (step === 'putIntentDurably') throw new SimulatedProcessDeath(step);
    });

    await assert.rejects(
      () => store.putIntentDurably(scenario.intent),
      SimulatedProcessDeath,
    );

    // Nothing persisted, so nothing to recover — and because step 6 has not
    // run, nothing was ever handed to the wallet. Safe by construction.
    assert.equal(await store.getSlot(scenario.intent.slotId), null);
    assert.deepEqual(await store.listNonTerminal(), []);
  });

  it('a kill between step 5 and step 6 leaves a resolvable record', async () => {
    const scenario = makeScenario();
    const store = new MemoryIntentStore();

    await store.putIntentDurably(scenario.intent);
    // The process dies here, before the wallet is invoked. Nothing was sent,
    // but the record exists — so recovery reads the nonce, finds it
    // unchanged, and returns NOT_SENT. This is fault F1.
    const stored = await store.getSlot(scenario.intent.slotId);
    assert.ok(stored !== null);
    assert.equal(stored.state, 'DRAFTED');

    // Everything needed to resolve is present.
    assert.equal(stored.intent.noncePubkey, scenario.intent.noncePubkey);
    assert.equal(stored.intent.nonceValueAtBuild, scenario.intent.nonceValueAtBuild);
    assert.equal(stored.intent.messageHash, scenario.intent.messageHash);
    assert.ok(stored.intent.messageBase64.length > 0);
    assert.ok(stored.intent.builtAtChainSlot > 0);
  });

  it('a kill during the wallet handoff leaves the slot IN_FLIGHT and resolvable', async () => {
    const scenario = makeScenario();
    const store = new MemoryIntentStore();

    await store.putIntentDurably(scenario.intent);
    await store.markInFlight(scenario.intent.slotId, 1_700_000_002_000);

    // This is fault F3, the money shot: the wallet has it, the app does not
    // know the outcome, and the process is gone. The record is sufficient.
    const stored = await store.getSlot(scenario.intent.slotId);
    assert.ok(stored !== null);
    assert.equal(stored.state, 'IN_FLIGHT');
    assert.equal(stored.verdict, null);

    const outstanding = await store.listNonTerminal();
    assert.equal(outstanding.length, 1);
  });

  it('a kill between markInFlight and its commit leaves the slot recoverable anyway', async () => {
    const scenario = makeScenario();
    const store = new MemoryIntentStore((step) => {
      if (step === 'markInFlight') throw new SimulatedProcessDeath(step);
    });

    await store.putIntentDurably(scenario.intent);
    await assert.rejects(
      () => store.markInFlight(scenario.intent.slotId, 1_700_000_002_000),
      SimulatedProcessDeath,
    );

    // The slot is still DRAFTED, which is also non-terminal, so the resolver
    // picks it up regardless. `IN_FLIGHT` is a display nicety; it is not load
    // bearing, and that is deliberate — nothing recovery needs may depend on
    // a write that happens after the wallet was invoked.
    const stored = await store.getSlot(scenario.intent.slotId);
    assert.ok(stored !== null);
    assert.equal(stored.state, 'DRAFTED');
    assert.equal((await store.listNonTerminal()).length, 1);
  });

  it('a kill during the resolver leaves the pre-verdict state, never a half verdict', async () => {
    const scenario = makeScenario();
    const store = new MemoryIntentStore((step) => {
      if (step === 'applyVerdict') throw new SimulatedProcessDeath(step);
    });

    await store.putIntentDurably(scenario.intent);
    await store.markInFlight(scenario.intent.slotId, 1_700_000_002_000);

    await assert.rejects(
      () =>
        store.applyVerdict({
          slotId: scenario.intent.slotId,
          state: 'SETTLED',
          reason: null,
          terminal: true,
          safeToRebroadcastIdenticalBytes: false,
          evidence: {
            observedNonceValue: freshNonceValue(),
            consumingSignature: 'sig',
            consumingSlot: 300_003,
            observedMessageHash: scenario.intent.messageHash,
            expectedMessageHash: scenario.intent.messageHash,
            expectedRawAmount: scenario.intent.transfer.expectedAmount,
            observedRawDelta: scenario.intent.transfer.expectedAmount,
            programLogs: [],
            transactionError: null,
          },
          decidedAtStep: 5,
          decidedAtSlot: 300_010,
          decidedAtMs: 1_700_000_050_000,
          i2Corroborated: true,
        }),
      SimulatedProcessDeath,
    );

    // This is fault F10. The slot is untouched, so the next pass re-reads the
    // nonce and reaches the same verdict. Resolution is idempotent precisely
    // so that being killed mid-resolve costs nothing but a retry.
    const stored = await store.getSlot(scenario.intent.slotId);
    assert.ok(stored !== null);
    assert.equal(stored.state, 'IN_FLIGHT');
    assert.equal(stored.verdict, null);
  });
});

describe('one slot, one intent', () => {
  it('refuses a second intent for the same slot', async () => {
    const scenario = makeScenario();
    const store = new MemoryIntentStore();
    await store.putIntentDurably(scenario.intent);

    // Two intents for one slot would mean two nonce anchors and the
    // possibility of two valid transfers. The store refuses rather than
    // letting the caller decide.
    await assert.rejects(() => store.putIntentDurably(scenario.intent), DuplicateSlotError);
  });

  it('a retried build keeps the nonce account it was already allocated', () => {
    const lease = makeLease();
    const slotId = deriveSlotId('thursday-circle', 7, Keypair.generate().publicKey.toBase58());

    const first = allocate(lease, slotId);
    const second = allocate(first.lease, slotId);

    // Allocation is idempotent. Handing a retrying slot a second account
    // would leak the first and, worse, could anchor a second live
    // transaction against it.
    assert.equal(second.account.pubkey, first.account.pubkey);
    assert.equal(
      second.lease.accounts.filter((account) => account.state === 'ALLOCATED').length,
      1,
    );
  });

  it('returns an unconsumed account straight to the pool after NOT_SENT', () => {
    const lease = makeLease();
    const slotId = deriveSlotId('thursday-circle', 7, Keypair.generate().publicKey.toBase58());

    const allocated = allocate(lease, slotId);
    const released = releaseUnconsumed(allocated.lease, slotId);

    const account = released.accounts.find(
      (candidate) => candidate.pubkey === allocated.account.pubkey,
    );
    assert.ok(account !== undefined);
    // Its nonce was never consumed, so it is still exactly what the pool
    // expects and needs no advance before reuse.
    assert.equal(account.state, 'AVAILABLE');
    assert.equal(account.heldBySlotId, null);
  });
});

describe('the intent is complete before the wallet is opened', () => {
  it('rejects an intent whose slot id does not derive from its own fields', () => {
    // The verifier must be able to confirm a slot id without trusting the
    // device that produced it, so a locally invented id is refused.
    assert.throws(
      () =>
        createIntentRecord({
          slotId: 'arbitrary-local-id',
          circleId: 'thursday-circle',
          roundIndex: 7,
          memberPubkey: Keypair.generate().publicKey.toBase58(),
          sourceTokenAccount: Keypair.generate().publicKey.toBase58(),
          destinationTokenAccount: Keypair.generate().publicKey.toBase58(),
          mint: Keypair.generate().publicKey.toBase58(),
          mintDecimals: 6,
          rawAmount: 1n,
          noncePubkey: Keypair.generate().publicKey.toBase58(),
          nonceAuthority: Keypair.generate().publicKey.toBase58(),
          nonceValue: freshNonceValue(),
          builtAtChainSlot: 1,
          walletCapabilities: CAPABILITIES_FULL,
          createdAtMs: 1,
        }),
      /slotId does not match/,
    );
  });

  it('refuses to build for a wallet without the mandatory signing method', () => {
    const member = Keypair.generate().publicKey.toBase58();
    assert.throws(
      () =>
        createIntentRecord({
          slotId: deriveSlotId('thursday-circle', 7, member),
          circleId: 'thursday-circle',
          roundIndex: 7,
          memberPubkey: member,
          sourceTokenAccount: Keypair.generate().publicKey.toBase58(),
          destinationTokenAccount: Keypair.generate().publicKey.toBase58(),
          mint: Keypair.generate().publicKey.toBase58(),
          mintDecimals: 6,
          rawAmount: 1n,
          noncePubkey: Keypair.generate().publicKey.toBase58(),
          nonceAuthority: Keypair.generate().publicKey.toBase58(),
          nonceValue: freshNonceValue(),
          builtAtChainSlot: 1,
          walletCapabilities: { ...CAPABILITIES_FULL, supportsSignAndSendTransactions: false },
          createdAtMs: 1,
        }),
      /does not report signAndSendTransactions/,
    );
  });
});

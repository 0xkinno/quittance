/**
 * The nonce lease.
 *
 * Two behaviours carry real weight here and both come from the runtime rather
 * than from preference:
 *
 *   A consumed account must be advanced before reuse, or every transaction
 *   built against it fails validation.
 *
 *   An account advances at most once per slot. The runtime rejects a second
 *   advance in the same slot with `NonceBlockhashNotExpired`
 *   (`docs/runtime-citations.md`, C5), so the lease declines to attempt one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Keypair } from '@solana/web3.js';

import {
  allocate,
  canAdvanceNow,
  leaseSummary,
  LeaseExhaustedError,
  provisioningShortfall,
  recordRecycled,
  recyclable,
  release,
  releaseUnconsumed,
  requiredAccountCount,
  retire,
} from '../src/nonce-lease.ts';
import type { LeasedNonceAccount, LeaseState } from '../src/nonce-lease.ts';

const AUTHORITY = Keypair.generate().publicKey.toBase58();

function account(overrides: Partial<LeasedNonceAccount> = {}): LeasedNonceAccount {
  return {
    pubkey: Keypair.generate().publicKey.toBase58(),
    authority: AUTHORITY,
    state: 'AVAILABLE',
    heldBySlotId: null,
    lastAdvancedAtChainSlot: 299_000,
    timesRecycled: 0,
    retiredReason: null,
    ...overrides,
  };
}

function lease(accounts: readonly LeasedNonceAccount[], entitled = 13): LeaseState {
  return {
    circleId: 'thursday-circle',
    payment: {
      paidBy: AUTHORITY,
      paymentSignature: null,
      skrMint: Keypair.generate().publicKey.toBase58(),
      paidRawAmount: 1_000_000_000n,
      mintIsGenuineSkr: false,
      entitledAccountCount: entitled,
    },
    accounts,
  };
}

describe('provisioning', () => {
  it('sizes a pool for one account per member plus a round-boundary spare', () => {
    assert.equal(requiredAccountCount(12), 13);
    assert.equal(requiredAccountCount(1), 2);
    assert.throws(() => requiredAccountCount(0), /positive integer/);
  });

  it('reports what still has to be created on chain', () => {
    const state = lease([account(), account(), account()]);
    assert.equal(provisioningShortfall(state, 12), 10);
  });

  it('does not count retired accounts toward the pool', () => {
    const state = lease([account(), account({ state: 'RETIRED' })]);
    assert.equal(provisioningShortfall(state, 1), 1);
  });

  it('never asks for more accounts than the lease was bought for', () => {
    const state = lease([account()], 4);
    // The purchase is the ceiling. Asking for twelve accounts against a lease
    // bought for four would provision accounts the lease has not paid rent for.
    assert.equal(provisioningShortfall(state, 12), 3);
  });
});

describe('allocation', () => {
  it('hands out an available account and marks it held', () => {
    const state = lease([account(), account()]);
    const { lease: next, account: allocated } = allocate(state, 'slot-a');

    assert.equal(allocated.state, 'ALLOCATED');
    assert.equal(allocated.heldBySlotId, 'slot-a');
    assert.equal(leaseSummary(next).ALLOCATED, 1);
    assert.equal(leaseSummary(next).AVAILABLE, 1);
  });

  it('is deterministic, so a campaign run reproduces from its seed', () => {
    const accounts = [account(), account(), account()];
    const first = allocate(lease(accounts), 'slot-a').account.pubkey;
    const second = allocate(lease(accounts), 'slot-a').account.pubkey;
    assert.equal(first, second);
  });

  it('throws rather than silently reusing an account when the pool is empty', () => {
    const state = lease([account({ state: 'AWAITING_RECYCLE' })]);
    assert.throws(() => allocate(state, 'slot-a'), LeaseExhaustedError);
  });

  it('will not allocate a retired account', () => {
    const state = lease([account({ state: 'RETIRED', retiredReason: 'foreign consumer' })]);
    assert.throws(() => allocate(state, 'slot-a'), LeaseExhaustedError);
  });
});

describe('release and recycling', () => {
  it('a consumed account awaits recycling rather than returning to the pool', () => {
    const state = lease([account()]);
    const allocated = allocate(state, 'slot-a');
    const released = release(allocated.lease, 'slot-a');

    // Its nonce has been consumed. Handing it straight to the next member
    // would give them an account whose stored value matches nothing, and
    // every transaction built against it would fail validation.
    assert.equal(leaseSummary(released).AWAITING_RECYCLE, 1);
    assert.equal(leaseSummary(released).AVAILABLE, 0);
  });

  it('an unconsumed account returns to the pool directly', () => {
    const state = lease([account()]);
    const allocated = allocate(state, 'slot-a');
    const released = releaseUnconsumed(allocated.lease, 'slot-a');
    assert.equal(leaseSummary(released).AVAILABLE, 1);
  });

  it('refuses an advance on an account that already advanced this slot', () => {
    const stale = account({ state: 'AWAITING_RECYCLE', lastAdvancedAtChainSlot: 300_000 });
    const verdict = canAdvanceNow(stale, 300_000);

    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason ?? '', /once per slot/);
  });

  it('permits an advance once the chain has moved past that slot', () => {
    const ready = account({ state: 'AWAITING_RECYCLE', lastAdvancedAtChainSlot: 300_000 });
    assert.equal(canAdvanceNow(ready, 300_001).allowed, true);
  });

  it('never permits an advance on a retired account', () => {
    const dead = account({ state: 'RETIRED', retiredReason: 'unexplained history' });
    assert.equal(canAdvanceNow(dead, 400_000).allowed, false);
  });

  it('lists only the accounts that can be advanced right now', () => {
    const ready = account({ state: 'AWAITING_RECYCLE', lastAdvancedAtChainSlot: 299_999 });
    const blocked = account({ state: 'AWAITING_RECYCLE', lastAdvancedAtChainSlot: 300_000 });
    const state = lease([ready, blocked, account()]);

    const list = recyclable(state, 300_000);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.pubkey, ready.pubkey);
  });

  it('returns an account to the pool only after a confirmed advance', () => {
    const consumed = account({ state: 'AWAITING_RECYCLE' });
    const state = lease([consumed]);
    const recycled = recordRecycled(state, consumed.pubkey, 300_500);

    const updated = recycled.accounts[0];
    assert.ok(updated !== undefined);
    assert.equal(updated.state, 'AVAILABLE');
    assert.equal(updated.lastAdvancedAtChainSlot, 300_500);
    assert.equal(updated.timesRecycled, 1);
  });

  it('recycling pays rent once for the life of the circle, not once per payment', () => {
    // Twelve rounds of one member through a single account. Rent was paid
    // when the account was created and never again. This is the whole
    // economic argument for the lease.
    let state = lease([account()]);
    for (let round = 0; round < 12; round += 1) {
      const allocated = allocate(state, `slot-${round}`);
      state = recordRecycled(
        release(allocated.lease, `slot-${round}`),
        allocated.account.pubkey,
        300_000 + round + 1,
      );
    }
    const final = state.accounts[0];
    assert.ok(final !== undefined);
    assert.equal(final.timesRecycled, 12);
    assert.equal(state.accounts.length, 1);
  });
});

describe('retirement', () => {
  it('withholds an account permanently with the reason recorded', () => {
    const suspect = account();
    const state = retire(lease([suspect]), suspect.pubkey, 'consumed by a foreign transaction');

    const updated = state.accounts[0];
    assert.ok(updated !== undefined);
    assert.equal(updated.state, 'RETIRED');
    assert.equal(updated.retiredReason, 'consumed by a foreign transaction');
    // There is no path back. An account whose history is not understood must
    // never again be used to decide whether money moved.
    assert.throws(() => allocate(state, 'slot-a'), LeaseExhaustedError);
  });
});

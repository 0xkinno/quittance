/**
 * The nonce lease.
 *
 * The guarantee has a cost, and the lease is what makes that cost bearable.
 *
 * Every contribution slot needs its own durable nonce account, and a nonce
 * account must be rent-exempt. Asking a market trader to fund a rent-exempt
 * account before she can pay her weekly contribution does not reduce the
 * product's appeal, it removes the product. So the circle organizer **buys**
 * a lease with SKR, once, and the lease pre-provisions a rotating pool of
 * nonce accounts for the circle:
 *
 *   - no member ever funds a nonce account;
 *   - no payment ever blocks on account creation at the moment of paying;
 *   - accounts are recycled between rounds by advancing them, so rent is paid
 *     once for the life of the circle rather than once per payment.
 *
 * This is not a fee discount, and it is deliberately not a stake. SKR is
 * *spent* to provision the pool: the payment buys the rent that keeps the
 * nonce accounts alive for the life of the circle. Without the lease the
 * guarantee is unaffordable; with it the guarantee is free at the point of
 * use. If the lease were removed the product would not get more expensive,
 * it would stop working as a consumer product.
 *
 * That the asset is spent rather than locked is what makes it a utility
 * integration: SKR is the thing that buys the thing that makes the guarantee
 * possible, and the circle holds no position in it afterwards.
 *
 * This module is the pure part: the pool's state machine, allocation,
 * release, and recycling eligibility. It holds no keys, signs nothing, and
 * performs no network calls. `LeaseProvisioner` in the app supplies the
 * on-chain side.
 */

import type { Base58PublicKey, Base58Signature } from './types.ts';

// ---------------------------------------------------------------------------
// Pool entries
// ---------------------------------------------------------------------------

export const LEASED_ACCOUNT_STATES = [
  /** Rent-exempt, initialized, nonce unadvanced since last recycle, free. */
  'AVAILABLE',
  /** Handed to one contribution slot. Not reusable until that slot is terminal. */
  'ALLOCATED',
  /**
   * The slot that held it reached a terminal state. The account's nonce has
   * been consumed and must be advanced once before it is available again.
   */
  'AWAITING_RECYCLE',
  /**
   * Withheld. Either the account failed validation or an operator retired it.
   * A retired account is never reallocated, because an account whose history
   * is not understood must not be used to decide whether money moved.
   */
  'RETIRED',
] as const;

export type LeasedAccountState = (typeof LEASED_ACCOUNT_STATES)[number];

export interface LeasedNonceAccount {
  readonly pubkey: Base58PublicKey;
  /** The authority that must sign the first instruction of every nonce tx. */
  readonly authority: Base58PublicKey;
  readonly state: LeasedAccountState;
  /** The slot id currently holding it, when `ALLOCATED`. */
  readonly heldBySlotId: string | null;
  /**
   * The chain slot this account's nonce was last advanced at.
   *
   * Load-bearing: `AdvanceNonceAccount` fails with
   * `NonceBlockhashNotExpired` when the account has already advanced in the
   * current slot — the runtime permits one advance per account per slot
   * (`docs/runtime-citations.md`, C5). Recycling and reissue are therefore
   * slot-aware, and the lease refuses to attempt an advance it knows will be
   * rejected rather than discovering it as a failed transaction.
   */
  readonly lastAdvancedAtChainSlot: number | null;
  /** Rounds this account has served, for the evidence record. */
  readonly timesRecycled: number;
  readonly retiredReason: string | null;
}

export interface LeaseState {
  readonly circleId: string;
  /** The purchase that underwrote the pool. */
  readonly payment: LeasePayment;
  readonly accounts: readonly LeasedNonceAccount[];
}

export interface LeasePayment {
  /** The organizer who bought the lease, and the nonce authority for the pool. */
  readonly paidBy: Base58PublicKey;
  /** The SKR mint this lease is denominated in. */
  readonly skrMint: Base58PublicKey;
  /**
   * Raw amount of SKR spent, in the mint's smallest unit.
   *
   * Spent, not locked. There is no position to unwind, no unbonding period,
   * and nothing for the circle to withdraw later: the SKR bought the rent
   * that keeps the pool's nonce accounts alive.
   */
  readonly paidRawAmount: bigint;
  /**
   * The signature of the SKR payment that opened this lease.
   *
   * Recorded so the lease is auditable the same way a contribution is: one
   * pubkey and one signature, and a stranger can confirm the pool was paid
   * for without access to the app.
   */
  readonly paymentSignature: Base58Signature | null;
  /**
   * `true` when `skrMint` is the real SKR mint, `false` when it is a stand-in
   * used because SKR is not available on the cluster being built against.
   *
   * Nothing in this codebase presents a stand-in as real: the app renders a
   * labelled notice whenever this is `false`, and `LIMITATIONS.md` states it
   * against the specific claim it affects.
   */
  readonly mintIsGenuineSkr: boolean;
  /** How many nonce accounts this payment entitles the circle to hold. */
  readonly entitledAccountCount: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LeaseExhaustedError extends Error {
  readonly circleId: string;
  readonly requested: number;
  readonly available: number;

  constructor(circleId: string, requested: number, available: number) {
    super(
      `The nonce lease for circle ${circleId} has ${available} available accounts and ` +
        `${requested} were requested. Recycle consumed accounts or extend the lease.`,
    );
    this.name = 'LeaseExhaustedError';
    this.circleId = circleId;
    this.requested = requested;
    this.available = available;
  }
}

export class LeaseAccountNotHeldError extends Error {
  readonly pubkey: Base58PublicKey;
  readonly slotId: string;

  constructor(pubkey: Base58PublicKey, slotId: string) {
    super(`Nonce account ${pubkey} is not allocated to slot ${slotId}.`);
    this.name = 'LeaseAccountNotHeldError';
    this.pubkey = pubkey;
    this.slotId = slotId;
  }
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/** Lamports a rent-exempt nonce account must hold: 80 bytes of state. */
export const NONCE_ACCOUNT_SIZE_BYTES = 80;

/**
 * How many accounts a circle needs to never block at the moment of paying.
 *
 * One per member for the current round, plus one spare per concurrent round
 * boundary so that a member paying early for the next round does not have to
 * wait for the previous round's accounts to finish recycling.
 */
export function requiredAccountCount(memberCount: number): number {
  if (!Number.isInteger(memberCount) || memberCount < 1) {
    throw new Error('requiredAccountCount: memberCount must be a positive integer');
  }
  return memberCount + 1;
}

/**
 * The accounts that still have to be created on chain for this lease to be
 * able to serve a round without blocking.
 */
export function provisioningShortfall(lease: LeaseState, memberCount: number): number {
  const usable = lease.accounts.filter((account) => account.state !== 'RETIRED').length;
  const required = Math.min(requiredAccountCount(memberCount), lease.payment.entitledAccountCount);
  return Math.max(0, required - usable);
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/**
 * Allocate one nonce account to one contribution slot.
 *
 * Returns a new lease state; nothing is mutated. Allocation is deterministic —
 * the lexicographically first available account is taken — so that a campaign
 * run is reproducible from its seed and a verifier can confirm which account
 * a slot should have received.
 */
export function allocate(
  lease: LeaseState,
  slotId: string,
): { readonly lease: LeaseState; readonly account: LeasedNonceAccount } {
  const existing = lease.accounts.find(
    (account) => account.state === 'ALLOCATED' && account.heldBySlotId === slotId,
  );
  if (existing !== undefined) {
    // Idempotent: a slot that is retrying its build keeps the account it was
    // already given. Handing it a second account would leave the first one
    // allocated forever and, worse, could anchor a second live transaction.
    return { lease, account: existing };
  }

  const available = lease.accounts
    .filter((account) => account.state === 'AVAILABLE')
    .sort((a, b) => a.pubkey.localeCompare(b.pubkey));

  const chosen = available[0];
  if (chosen === undefined) {
    throw new LeaseExhaustedError(lease.circleId, 1, 0);
  }

  const allocated: LeasedNonceAccount = {
    ...chosen,
    state: 'ALLOCATED',
    heldBySlotId: slotId,
  };
  return { lease: replaceAccount(lease, allocated), account: allocated };
}

/**
 * Release an account after its slot reached a terminal state.
 *
 * The account does not become available: it becomes `AWAITING_RECYCLE`,
 * because its nonce has been consumed and a consumed nonce cannot anchor a
 * new transaction until it is advanced. Returning it straight to `AVAILABLE`
 * would hand the next member an account whose stored nonce no longer matches
 * anything, and every transaction built against it would fail validation.
 */
export function release(lease: LeaseState, slotId: string): LeaseState {
  const held = lease.accounts.find(
    (account) => account.state === 'ALLOCATED' && account.heldBySlotId === slotId,
  );
  if (held === undefined) return lease;
  return replaceAccount(lease, {
    ...held,
    state: 'AWAITING_RECYCLE',
    heldBySlotId: null,
  });
}

/**
 * Release an account whose slot was resolved `NOT_SENT`.
 *
 * This is the one case where the account goes straight back to `AVAILABLE`:
 * the nonce was never consumed, so the account is still in exactly the state
 * the pool expects. It is a separate function from `release` so that no
 * caller can reach this path by accident — it is only correct when a verdict
 * proved the transaction was never processed.
 */
export function releaseUnconsumed(lease: LeaseState, slotId: string): LeaseState {
  const held = lease.accounts.find(
    (account) => account.state === 'ALLOCATED' && account.heldBySlotId === slotId,
  );
  if (held === undefined) return lease;
  return replaceAccount(lease, { ...held, state: 'AVAILABLE', heldBySlotId: null });
}

// ---------------------------------------------------------------------------
// Recycling
// ---------------------------------------------------------------------------

/**
 * Whether an advance may be attempted on this account right now.
 *
 * Refuses when the account already advanced in the observed chain slot,
 * because the runtime rejects a second advance in the same slot with
 * `NonceBlockhashNotExpired` (C5). The lease declines to send a transaction
 * it knows will be rejected rather than spending a fee to discover it.
 */
export function canAdvanceNow(
  account: LeasedNonceAccount,
  observedAtSlot: number,
): { readonly allowed: boolean; readonly reason: string | null } {
  if (account.state === 'RETIRED') {
    return { allowed: false, reason: 'the account is retired and is never reused' };
  }
  if (
    account.lastAdvancedAtChainSlot !== null &&
    account.lastAdvancedAtChainSlot >= observedAtSlot
  ) {
    return {
      allowed: false,
      reason: 'this account already advanced in the current slot; a nonce advances once per slot',
    };
  }
  return { allowed: true, reason: null };
}

/** Accounts that are waiting to be recycled and may be advanced right now. */
export function recyclable(
  lease: LeaseState,
  observedAtSlot: number,
): readonly LeasedNonceAccount[] {
  return lease.accounts.filter(
    (account) =>
      account.state === 'AWAITING_RECYCLE' && canAdvanceNow(account, observedAtSlot).allowed,
  );
}

/**
 * Record a confirmed advance, returning the account to the pool.
 *
 * Only called once the advance transaction has confirmed. Recording it
 * optimistically would make the pool believe an account is reusable while its
 * stored nonce has not actually moved.
 */
export function recordRecycled(
  lease: LeaseState,
  pubkey: Base58PublicKey,
  advancedAtChainSlot: number,
): LeaseState {
  const account = lease.accounts.find((candidate) => candidate.pubkey === pubkey);
  if (account === undefined) return lease;
  return replaceAccount(lease, {
    ...account,
    state: 'AVAILABLE',
    heldBySlotId: null,
    lastAdvancedAtChainSlot: advancedAtChainSlot,
    timesRecycled: account.timesRecycled + 1,
  });
}

/**
 * Withhold an account permanently.
 *
 * Used when an account's history cannot be accounted for — a foreign
 * consumer, a failed validation, an authority that does not match the lease.
 * An account whose history is not understood must never again be used to
 * decide whether money moved, so there is no path back from `RETIRED`.
 */
export function retire(
  lease: LeaseState,
  pubkey: Base58PublicKey,
  reason: string,
): LeaseState {
  const account = lease.accounts.find((candidate) => candidate.pubkey === pubkey);
  if (account === undefined) return lease;
  return replaceAccount(lease, {
    ...account,
    state: 'RETIRED',
    heldBySlotId: null,
    retiredReason: reason,
  });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function replaceAccount(lease: LeaseState, next: LeasedNonceAccount): LeaseState {
  return {
    ...lease,
    accounts: lease.accounts.map((account) => (account.pubkey === next.pubkey ? next : account)),
  };
}

/** Counts by state, for the proof screen and the evidence manifest. */
export function leaseSummary(lease: LeaseState): Readonly<Record<LeasedAccountState, number>> {
  const summary: Record<LeasedAccountState, number> = {
    AVAILABLE: 0,
    ALLOCATED: 0,
    AWAITING_RECYCLE: 0,
    RETIRED: 0,
  };
  for (const account of lease.accounts) summary[account.state] += 1;
  return summary;
}

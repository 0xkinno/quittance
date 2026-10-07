/**
 * Broadcast and rebroadcast.
 *
 * This module is where the single strongest engineering claim in the project
 * lives, so it is worth stating plainly:
 *
 *   **The retry loop here can be dumb, and it still cannot double-charge.**
 *
 * Not because the loop is careful. Because a durable nonce transaction only
 * validates while the nonce account's stored value equals the value in the
 * transaction's blockhash field, and processing the transaction advances that
 * account *before* execution. A second broadcast of identical bytes therefore
 * fails `verify_nonce_account` and is rejected with `BlockhashNotFound`
 * before any instruction runs (`docs/runtime-citations.md`, C2).
 *
 * The exactly-once guarantee is enforced by the validator. It is not ours to
 * get wrong, and that is a stronger position than any amount of our own test
 * coverage. What this module must get right is narrower: never rebuild a
 * transaction against a fresh nonce while the old nonce is still unadvanced,
 * because *that* would create two independently valid transfers. The runtime
 * cannot protect against a second transaction it has never seen.
 */

import type { Base58Signature, IntentRecord, Verdict } from './types.ts';
import { base64ToBytes } from './canonical.ts';
import { DEFAULT_RETRY_POLICY, withRetry } from './chain.ts';
import type { RetryPolicy } from './chain.ts';

// ---------------------------------------------------------------------------
// The two ways bytes reach the cluster
// ---------------------------------------------------------------------------

/**
 * The wallet path. Implemented in the app over Mobile Wallet Adapter, and in
 * the harness over a local signer so the fault corpus can run unattended.
 *
 * This is the mandatory path under MWA 2.0: the wallet signs *and* submits,
 * and the caller learns the signature only if the session returns. The
 * `Promise` rejecting, or never settling because the process was killed, is
 * the normal case this whole system exists to handle — not an error path.
 */
export interface WalletBroadcaster {
  /**
   * Hand the compiled message to the wallet and let it sign and send.
   *
   * @returns the signature, if the session returned one.
   */
  signAndSend(intent: IntentRecord): Promise<Base58Signature>;
}

/** The direct path, used only for exact-byte rebroadcast of signed bytes. */
export interface RawBroadcaster {
  /**
   * Submit already-signed transaction bytes.
   *
   * Must be called with `skipPreflight` enabled. Preflight simulation of a
   * nonce transaction whose nonce has already advanced fails, and that
   * failure is exactly the outcome we are relying on the runtime to produce —
   * so letting preflight reject it client-side would hide the drop that
   * proves the guarantee, and would turn a safe no-op into a thrown error.
   */
  sendRaw(signedTransactionBytes: Uint8Array): Promise<Base58Signature>;
}

// ---------------------------------------------------------------------------
// Rebroadcast
// ---------------------------------------------------------------------------

export type RebroadcastOutcome =
  | { readonly kind: 'ACCEPTED'; readonly signature: Base58Signature; readonly attempts: number }
  | { readonly kind: 'DROPPED_BY_RUNTIME'; readonly attempts: number; readonly detail: string }
  | { readonly kind: 'NOT_PERMITTED'; readonly detail: string };

/**
 * Errors the runtime raises when a nonce transaction's nonce has already
 * advanced. Matched as substrings because the wire text differs between
 * node versions and RPC providers while the condition does not.
 *
 * Recognising the drop is not what makes the system safe — the drop happens
 * whether or not this list is complete. It is what lets the campaign *count*
 * drops, which is how F7 produces "nine drops, one effect" instead of nine
 * unexplained errors.
 */
const NONCE_ALREADY_ADVANCED_MARKERS: readonly string[] = [
  'BlockhashNotFound',
  'Blockhash not found',
  'blockhash not found',
  'NonceBlockhashNotExpired',
];

export function looksLikeNonceAlreadyAdvanced(error: unknown): boolean {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '');
  return NONCE_ALREADY_ADVANCED_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Rebroadcast a contribution whose verdict is `NOT_SENT`.
 *
 * Two hard preconditions, both checked rather than documented:
 *
 *   1. The verdict must be `NOT_SENT`. That is the only verdict proving the
 *      nonce was never consumed, and therefore the only one under which a
 *      rebroadcast cannot be a second transfer.
 *   2. The bytes must be the recorded bytes. Nothing is rebuilt. A rebuild
 *      against a fresh nonce while the old nonce is unadvanced produces two
 *      live transactions, which is the one failure mode the runtime cannot
 *      protect us from.
 *
 * A drop is a success, not a failure: it means the original landed after all,
 * and the resolver will read the advanced nonce and produce the real verdict.
 */
export async function rebroadcast(args: {
  readonly intent: IntentRecord;
  readonly verdict: Verdict;
  readonly raw: RawBroadcaster | null;
  readonly wallet: WalletBroadcaster | null;
  readonly retryPolicy?: RetryPolicy;
}): Promise<RebroadcastOutcome> {
  if (args.verdict.state !== 'NOT_SENT' || !args.verdict.safeToRebroadcastIdenticalBytes) {
    return {
      kind: 'NOT_PERMITTED',
      detail:
        `The slot is ${args.verdict.state}, and only NOT_SENT authorizes a rebroadcast. ` +
        'Any other state means the nonce was consumed, so resending could only ever be a ' +
        'second transfer or a wasted fee.',
    };
  }

  const policy = args.retryPolicy ?? DEFAULT_RETRY_POLICY;
  let attempts = 0;

  // Preferred path: the exact bytes the wallet produced, when the optional
  // `signTransactions` method was available at build time. No wallet round
  // trip, so this works with the app in the background.
  if (args.intent.signedTransactionBase64 !== null && args.raw !== null) {
    const bytes = base64ToBytes(args.intent.signedTransactionBase64);
    const raw = args.raw;
    try {
      const signature = await withRetry(
        async () => {
          attempts += 1;
          return raw.sendRaw(bytes);
        },
        policy,
      );
      return { kind: 'ACCEPTED', signature, attempts };
    } catch (error) {
      if (looksLikeNonceAlreadyAdvanced(unwrapCause(error))) {
        return {
          kind: 'DROPPED_BY_RUNTIME',
          attempts,
          detail:
            'The runtime rejected the rebroadcast because the nonce had already advanced. ' +
            'The original transaction was processed; the duplicate never executed.',
        };
      }
      throw error;
    }
  }

  // Fallback path: ask the wallet to sign and send the recorded message
  // again. Identical in safety — the nonce is what makes it safe, not the
  // byte-for-byte reuse. It costs one wallet round trip and needs the member
  // present, which is why the optimization above exists.
  if (args.wallet !== null) {
    const wallet = args.wallet;
    try {
      const signature = await withRetry(
        async () => {
          attempts += 1;
          return wallet.signAndSend(args.intent);
        },
        policy,
      );
      return { kind: 'ACCEPTED', signature, attempts };
    } catch (error) {
      if (looksLikeNonceAlreadyAdvanced(unwrapCause(error))) {
        return {
          kind: 'DROPPED_BY_RUNTIME',
          attempts,
          detail:
            'The wallet reported that the network rejected the resend because the nonce had ' +
            'already advanced. The original transaction was processed.',
        };
      }
      throw error;
    }
  }

  return {
    kind: 'NOT_PERMITTED',
    detail: 'No broadcaster was supplied, so nothing was sent.',
  };
}

function unwrapCause(error: unknown): unknown {
  if (error instanceof Error && 'cause' in error && error.cause !== undefined) {
    return error.cause;
  }
  return error;
}

// ---------------------------------------------------------------------------
// The first broadcast
// ---------------------------------------------------------------------------

export type SendOutcome =
  | { readonly kind: 'SESSION_RETURNED'; readonly signature: Base58Signature }
  /**
   * The session did not return a signature. This is the condition the entire
   * product is built around and it is explicitly **not** an error: the
   * transaction may well have been broadcast and may already be final. The
   * slot stays `IN_FLIGHT` and the resolver answers the question from the
   * nonce account.
   */
  | { readonly kind: 'SESSION_LOST'; readonly detail: string };

/**
 * Step 6. Hand a persisted intent to the wallet.
 *
 * The caller must have completed step 5 — the durable write — before calling
 * this. `assertPersistedBeforeSend` exists so that ordering is enforced by
 * the type system's nearest available equivalent, a loud runtime check, and
 * not by a comment somebody will eventually move.
 *
 * Note what this function does **not** do: it does not retry. A failed first
 * broadcast is indistinguishable from a successful one whose session died, so
 * retrying here would be guessing. Resolution is the resolver's job, and it
 * works from chain state rather than from hope.
 */
export async function sendForFirstTime(args: {
  readonly intent: IntentRecord;
  readonly wallet: WalletBroadcaster;
  readonly persisted: boolean;
}): Promise<SendOutcome> {
  assertPersistedBeforeSend(args.intent, args.persisted);
  try {
    const signature = await args.wallet.signAndSend(args.intent);
    return { kind: 'SESSION_RETURNED', signature };
  } catch (error) {
    return {
      kind: 'SESSION_LOST',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export class IntentNotPersistedError extends Error {
  readonly slotId: string;

  constructor(slotId: string) {
    super(
      `Slot ${slotId} was about to be sent to the wallet without a durable intent on disk. ` +
        'If the process died during the handoff there would be nothing to recover from: no ' +
        'nonce value to compare, no message hash to match, and a payment that may have ' +
        'happened. The send is refused.',
    );
    this.name = 'IntentNotPersistedError';
    this.slotId = slotId;
  }
}

export function assertPersistedBeforeSend(intent: IntentRecord, persisted: boolean): void {
  if (!persisted) throw new IntentNotPersistedError(intent.slotId);
}

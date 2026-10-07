/**
 * The chain boundary.
 *
 * This is the only module in the engine that touches the network. Everything
 * downstream of it — the verdict machine, the invariants, the verifier —
 * operates on the plain `ChainSnapshot` it produces. That separation is what
 * makes the verdict machine testable without a network and identical in the
 * app and in the offline verifier.
 *
 * Commitment handling is deliberate and is stated rather than defaulted:
 *
 *   The nonce account read uses **`finalized`**. The nonce value is the whole
 *   oracle, and a verdict derived from a `confirmed` read could be
 *   invalidated by a fork. `NOT_SENT` in particular authorizes a rebroadcast,
 *   and a rebroadcast decided on forkable data is the one way this design
 *   could double-charge. So the read that can authorize a rebroadcast is the
 *   read that waits for finality.
 *
 *   The signature and transaction reads also use `finalized`, for the same
 *   reason: a `SETTLED` verdict is a claim that money moved.
 *
 * The cost is latency, and the Recovering screen is specified to resolve in
 * under two seconds, so the snapshot's three reads are issued concurrently
 * rather than in sequence.
 */

import type { Connection, Finality } from '@solana/web3.js';
import { NONCE_ACCOUNT_LENGTH, NonceAccount, PublicKey } from '@solana/web3.js';

import { bytesToBase64 } from './canonical.ts';
import type {
  Base58PublicKey,
  Base58Signature,
  ChainSnapshot,
  IntentRecord,
  NonceAccountSnapshot,
  RawAmount,
  SignatureEntry,
  TransactionSnapshot,
} from './types.ts';

/**
 * Every verdict-bearing read is finalized. See the module comment: a verdict
 * is a statement about money, and `NOT_SENT` authorizes a rebroadcast.
 */
export const VERDICT_COMMITMENT: Finality = 'finalized';

/** How many signatures to pull for a nonce account. */
const SIGNATURE_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 4,
  baseDelayMs: 150,
  maxDelayMs: 1_500,
};

/**
 * Bounded exponential backoff with full jitter.
 *
 * Bounded on purpose. An unbounded read retry would let the Recovering screen
 * hang indefinitely, and a screen that never answers is worse for the member
 * than one that says it could not reach the network and offers to try again.
 * Exhausting the retries is reported, never swallowed.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  random: () => number = Math.random,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === policy.attempts - 1) break;
      const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
      await sleep(Math.floor(random() * ceiling));
    }
  }
  throw new ChainReadError(policy.attempts, lastError);
}

export class ChainReadError extends Error {
  readonly attempts: number;
  override readonly cause: unknown;

  constructor(attempts: number, cause: unknown) {
    super(
      `The network did not answer after ${attempts} attempts. No verdict was produced, and ` +
        'the slot keeps the state it already had.',
    );
    this.name = 'ChainReadError';
    this.attempts = attempts;
    this.cause = cause;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// The reader interface
// ---------------------------------------------------------------------------

/**
 * The reads a snapshot needs.
 *
 * An interface rather than a concrete class so the harness can inject a
 * fault-injecting proxy for F6 (RPC timeout and stale-slot responses) without
 * any of the engine knowing it happened.
 */
export interface ChainReader {
  readNonceAccount(noncePubkey: Base58PublicKey): Promise<NonceAccountSnapshot>;
  readNonceSignatures(noncePubkey: Base58PublicKey): Promise<readonly SignatureEntry[]>;
  readTransaction(
    signature: Base58Signature,
    expectedDestination: Base58PublicKey,
  ): Promise<TransactionSnapshot>;
  readCurrentSlot(): Promise<number>;
  readFirstAvailableSlot(): Promise<number | null>;
}

// ---------------------------------------------------------------------------
// The web3.js implementation
// ---------------------------------------------------------------------------

/**
 * Reads chain state over a `Connection`.
 *
 * Built against Helius for devnet and mainnet. The endpoint host is recorded
 * in the evidence manifest so that a reader can tell which provider produced
 * a given campaign row, and the retry behaviour above is documented rather
 * than implicit.
 */
export class Web3ChainReader implements ChainReader {
  private readonly connection: Connection;
  private readonly retryPolicy: RetryPolicy;

  constructor(connection: Connection, retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY) {
    this.connection = connection;
    this.retryPolicy = retryPolicy;
  }

  async readNonceAccount(noncePubkey: Base58PublicKey): Promise<NonceAccountSnapshot> {
    const pubkey = new PublicKey(noncePubkey);
    return withRetry(async () => {
      const account = await this.connection.getAccountInfo(pubkey, VERDICT_COMMITMENT);
      if (account === null) return { exists: false } as const;
      if (account.data.length < NONCE_ACCOUNT_LENGTH) {
        // An account exists at this address and it is not a nonce account.
        // Reported as absent rather than parsed optimistically: the verdict
        // machine escalates it as NONCE_ACCOUNT_GONE, which is the honest
        // outcome. Nothing here guesses at what the account might be.
        return { exists: false } as const;
      }
      const nonce = NonceAccount.fromAccountData(account.data);
      return {
        exists: true,
        nonceValue: nonce.nonce,
        authority: nonce.authorizedPubkey.toBase58(),
        lamports: account.lamports,
      } as const;
    }, this.retryPolicy);
  }

  async readNonceSignatures(
    noncePubkey: Base58PublicKey,
  ): Promise<readonly SignatureEntry[]> {
    const pubkey = new PublicKey(noncePubkey);
    return withRetry(async () => {
      const entries = await this.connection.getSignaturesForAddress(
        pubkey,
        { limit: SIGNATURE_PAGE_SIZE },
        VERDICT_COMMITMENT,
      );
      return entries.map((entry) => ({
        signature: entry.signature,
        slot: entry.slot,
        hasError: entry.err !== null,
        blockTimeSec: entry.blockTime ?? null,
      }));
    }, this.retryPolicy);
  }

  async readTransaction(
    signature: Base58Signature,
    expectedDestination: Base58PublicKey,
  ): Promise<TransactionSnapshot> {
    return withRetry(async () => {
      const transaction = await this.connection.getTransaction(signature, {
        commitment: VERDICT_COMMITMENT,
        maxSupportedTransactionVersion: 0,
      });
      if (transaction === null) return { available: false } as const;

      const messageBytes = new Uint8Array(transaction.transaction.message.serialize());

      return {
        available: true,
        signature,
        slot: transaction.slot,
        messageBase64: bytesToBase64(messageBytes),
        err: transaction.meta?.err ?? null,
        logs: transaction.meta?.logMessages ?? [],
        destinationRawDelta: extractDestinationDelta(transaction, expectedDestination),
      } as const;
    }, this.retryPolicy);
  }

  async readCurrentSlot(): Promise<number> {
    return withRetry(() => this.connection.getSlot(VERDICT_COMMITMENT), this.retryPolicy);
  }

  async readFirstAvailableSlot(): Promise<number | null> {
    try {
      return await withRetry(() => this.connection.getFirstAvailableBlock(), this.retryPolicy);
    } catch {
      // Not every provider serves this. Returning `null` is correct and the
      // verdict machine handles it: without it, "no signatures" cannot be
      // distinguished from "cannot see that far back", so the machine
      // escalates rather than concluding.
      return null;
    }
  }
}

/**
 * Pull the raw token-balance delta for the expected destination.
 *
 * Returns `null` when the node did not supply token balances for this
 * transaction. The verdict machine treats `null` as "the corroboration did
 * not run" and records that truthfully, rather than substituting a zero and
 * manufacturing a disagreement.
 */
function extractDestinationDelta(
  transaction: {
    readonly meta: {
      readonly preTokenBalances?: readonly TokenBalanceLike[] | null;
      readonly postTokenBalances?: readonly TokenBalanceLike[] | null;
    } | null;
    readonly transaction: {
      readonly message: { getAccountKeys?: unknown; staticAccountKeys?: readonly PublicKey[] };
    };
  },
  expectedDestination: Base58PublicKey,
): RawAmount | null {
  const pre = transaction.meta?.preTokenBalances ?? null;
  const post = transaction.meta?.postTokenBalances ?? null;
  if (pre === null || post === null) return null;

  const keys = transaction.transaction.message.staticAccountKeys ?? [];
  const destinationIndex = keys.findIndex((key) => key.toBase58() === expectedDestination);
  if (destinationIndex < 0) return null;

  const before = pre.find((entry) => entry.accountIndex === destinationIndex);
  const after = post.find((entry) => entry.accountIndex === destinationIndex);
  if (after === undefined) return null;

  const beforeAmount = before === undefined ? 0n : BigInt(before.uiTokenAmount.amount);
  const afterAmount = BigInt(after.uiTokenAmount.amount);
  return afterAmount - beforeAmount;
}

interface TokenBalanceLike {
  readonly accountIndex: number;
  readonly uiTokenAmount: { readonly amount: string };
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the snapshot the verdict machine needs for one intent.
 *
 * The nonce read, the slot read, and the retention read are issued
 * concurrently. Transactions are fetched only for the signatures that could
 * possibly be the consumer — those at or after the slot the nonce value was
 * read at — so a nonce account with a long history still resolves in one
 * round trip plus one.
 *
 * When the nonce is unchanged the function returns before fetching any
 * signatures at all, because step 1 is already terminal. That is the common
 * recovery case and it is why the Recovering screen is fast.
 */
export async function captureSnapshot(
  reader: ChainReader,
  intent: IntentRecord,
): Promise<ChainSnapshot> {
  const [nonceAccount, observedAtSlot, firstAvailableSlot] = await Promise.all([
    reader.readNonceAccount(intent.noncePubkey),
    reader.readCurrentSlot(),
    reader.readFirstAvailableSlot(),
  ]);

  const observedAtMs = Date.now();

  if (!nonceAccount.exists || nonceAccount.nonceValue === intent.nonceValueAtBuild) {
    return {
      nonceAccount,
      nonceSignatures: [],
      transactions: {},
      observedAtSlot,
      observedAtMs,
      firstAvailableSlot,
    };
  }

  const nonceSignatures = await reader.readNonceSignatures(intent.noncePubkey);
  const candidates = nonceSignatures.filter((entry) => entry.slot >= intent.builtAtChainSlot);

  const fetched = await Promise.all(
    candidates.map(async (entry) => {
      const snapshot = await reader.readTransaction(
        entry.signature,
        intent.transfer.expectedTo,
      );
      return [entry.signature, snapshot] as const;
    }),
  );

  return {
    nonceAccount,
    nonceSignatures,
    transactions: Object.fromEntries(fetched),
    observedAtSlot,
    observedAtMs,
    firstAvailableSlot,
  };
}

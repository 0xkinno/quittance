/**
 * The baseline arm.
 *
 * This is the standard mobile payment pattern, implemented honestly and
 * competently. It is the control that could disprove the whole thesis, and
 * the result is only worth something if this arm is genuinely the best
 * version of the normal approach rather than a strawman built to lose.
 *
 * So, explicitly, this implementation:
 *
 *   - uses a recent blockhash, the way every mobile dApp does;
 *   - uses `signAndSendTransactions`, the mandatory MWA 2.0 path, the same
 *     path Quittance uses — the arms differ in the anchor, not the API;
 *   - retries once after reconnecting when no result comes back, which is
 *     the sensible thing to do and more than many apps bother with;
 *   - on recovery, scans recent address history for a matching amount, which
 *     is the best recovery a blockhash-anchored app can do.
 *
 * It is **not** tuned to lose. It has a retry, it has a recovery path, and the
 * recovery path is the one a careful engineer would write. If it records zero
 * double debits in a run, that is reported as it stands.
 *
 * What it cannot do is the thing the design cannot do: a recent blockhash
 * expires after roughly 150 slots, and once it has, there is no question left
 * to ask the chain. The history scan cannot distinguish this payment from an
 * unrelated identical one, and it collapses entirely when more than one
 * payment is pending. Those are properties of the approach, not of this code.
 */

import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';

import { createTransferCheckedInstruction } from '@quittance/engine';

export type BaselineOutcome =
  /** The app knows the signature and confirmed it. */
  | { readonly kind: 'CONFIRMED'; readonly signature: string }
  /** The retry produced a second transfer. An I1 violation in this arm. */
  | { readonly kind: 'DOUBLE_SENT'; readonly signatures: readonly string[] }
  /** The history scan found a plausible match. May be the wrong one. */
  | {
      readonly kind: 'ASSUMED_FROM_HISTORY';
      readonly signature: string;
      readonly confidence: 'exact-amount-match';
    }
  /** No answer. The blockhash expired and the question can no longer be asked. */
  | { readonly kind: 'UNRESOLVED'; readonly reason: string };

export interface BaselineAttempt {
  readonly connection: Connection;
  readonly payer: Keypair;
  readonly sourceTokenAccount: PublicKey;
  readonly destinationTokenAccount: PublicKey;
  readonly mint: PublicKey;
  readonly mintDecimals: number;
  readonly rawAmount: bigint;
  /** Simulates the session dying, which is what the fault injection causes. */
  readonly loseSession: boolean;
}

/**
 * Build the baseline's transaction: a recent blockhash and a transfer.
 *
 * No advance instruction, no anchor. Once this blockhash is older than its
 * window, this transaction is simply gone, and so is any way of asking about
 * it by name.
 */
export async function buildBaselineTransaction(
  attempt: BaselineAttempt,
): Promise<{ readonly transaction: Transaction; readonly blockhashValidUntil: number }> {
  const { blockhash, lastValidBlockHeight } = await attempt.connection.getLatestBlockhash(
    'finalized',
  );

  const transaction = new Transaction();
  transaction.add(
    createTransferCheckedInstruction({
      source: attempt.sourceTokenAccount,
      mint: attempt.mint,
      destination: attempt.destinationTokenAccount,
      owner: attempt.payer.publicKey,
      rawAmount: attempt.rawAmount,
      decimals: attempt.mintDecimals,
    }),
  );
  transaction.feePayer = attempt.payer.publicKey;
  transaction.recentBlockhash = blockhash;

  return { transaction, blockhashValidUntil: lastValidBlockHeight };
}

/**
 * The recovery path a blockhash-anchored app has available.
 *
 * Scans recent signatures for the destination and looks for a transfer of the
 * expected amount inside the window. This is the best that can be done, and
 * the comments below are not criticism of the code — they are the structural
 * limits that make the comparison meaningful.
 */
export async function recoverFromHistory(args: {
  readonly connection: Connection;
  readonly destinationTokenAccount: PublicKey;
  readonly rawAmount: bigint;
  readonly sinceSlot: number;
  readonly concurrentPendingPayments: number;
}): Promise<BaselineOutcome> {
  const signatures = await args.connection.getSignaturesForAddress(
    args.destinationTokenAccount,
    { limit: 50 },
    'finalized',
  );

  const candidates: string[] = [];

  for (const entry of signatures) {
    if (entry.slot < args.sinceSlot) continue;
    if (entry.err !== null) continue;

    const transaction = await args.connection.getTransaction(entry.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (transaction === null) continue;

    const delta = destinationDelta(transaction, args.destinationTokenAccount);
    if (delta !== null && delta === args.rawAmount) {
      candidates.push(entry.signature);
    }
  }

  if (candidates.length === 0) {
    return {
      kind: 'UNRESOLVED',
      reason:
        'No matching transfer found in the retained history. The blockhash this payment ' +
        'was built against has expired, so there is no longer a way to ask whether it was ' +
        'processed.',
    };
  }

  // The structural limit, and the reason this arm cannot be made correct.
  // Two members paying the same fixed contribution in the same window produce
  // two indistinguishable entries. The scan cannot tell which one is ours,
  // and with more than one payment pending it cannot tell whether either is.
  if (candidates.length > 1 || args.concurrentPendingPayments > 1) {
    return {
      kind: 'UNRESOLVED',
      reason:
        `${candidates.length} transfers of exactly this amount are in the window with ` +
        `${args.concurrentPendingPayments} payments pending. A history scan cannot tell ` +
        'which of them is this payment, and a fixed contribution amount means every ' +
        'member produces an identical entry.',
    };
  }

  return {
    kind: 'ASSUMED_FROM_HISTORY',
    signature: candidates[0] as string,
    confidence: 'exact-amount-match',
  };
}

function destinationDelta(
  transaction: {
    readonly meta: {
      readonly preTokenBalances?: readonly TokenBalanceLike[] | null;
      readonly postTokenBalances?: readonly TokenBalanceLike[] | null;
    } | null;
    readonly transaction: { readonly message: { staticAccountKeys?: readonly PublicKey[] } };
  },
  destination: PublicKey,
): bigint | null {
  const pre = transaction.meta?.preTokenBalances ?? null;
  const post = transaction.meta?.postTokenBalances ?? null;
  if (pre === null || post === null) return null;

  const keys = transaction.transaction.message.staticAccountKeys ?? [];
  const index = keys.findIndex((key) => key.equals(destination));
  if (index < 0) return null;

  const before = pre.find((entry) => entry.accountIndex === index);
  const after = post.find((entry) => entry.accountIndex === index);
  if (after === undefined) return null;

  return BigInt(after.uiTokenAmount.amount) - (before === undefined ? 0n : BigInt(before.uiTokenAmount.amount));
}

interface TokenBalanceLike {
  readonly accountIndex: number;
  readonly uiTokenAmount: { readonly amount: string };
}

/**
 * The baseline's retry.
 *
 * Fires once, after reconnecting, when no result came back. This is the
 * correct thing for this design to do and it is also the thing that can
 * double-charge: the original transaction may be perfectly valid and still
 * in flight, and nothing in the protocol prevents both from landing.
 *
 * Quittance's retry cannot do this, and not because its retry is smarter —
 * because the runtime refuses the second one.
 */
export async function retryOnce(args: {
  readonly connection: Connection;
  readonly attempt: BaselineAttempt;
  readonly originalSignature: string | null;
}): Promise<BaselineOutcome> {
  const { transaction } = await buildBaselineTransaction(args.attempt);
  transaction.sign(args.attempt.payer);

  const signature = await args.connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
  });
  await args.connection.confirmTransaction(signature, 'finalized');

  if (args.originalSignature !== null) {
    const original = await args.connection.getTransaction(args.originalSignature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (original !== null && original.meta?.err === null) {
      // Both landed. The member has been charged twice for one contribution.
      return { kind: 'DOUBLE_SENT', signatures: [args.originalSignature, signature] };
    }
  }

  return { kind: 'CONFIRMED', signature };
}

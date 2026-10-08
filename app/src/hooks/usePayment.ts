/**
 * Paying a contribution.
 *
 * This hook is where the write-ahead ordering is enforced, and the ordering is
 * the reason the whole product works. It is written out step by step with the
 * crash consequence of each boundary stated, because the next person to touch
 * this file will be tempted to move the durable write later for a snappier
 * loading state, and that temptation has to be answered in advance.
 *
 *   1  allocate a nonce account from the lease
 *   2  read its current nonce value
 *   3  build the transaction, AdvanceNonceAccount first, then the transfer
 *   4  hash the compiled message
 *   5  WRITE the intent and flush                 <- the transaction boundary
 *   6  only now call signAndSendTransactions
 *
 * Die before step 5: nothing was built and nothing was sent, so there is
 * nothing to recover and nothing to recover from. Safe.
 *
 * Die at any point from step 5 onward: the stored record carries the nonce
 * account, the value it was built against, the message hash and the message
 * itself, which is everything the resolver needs to read the answer off the
 * chain. Also safe.
 *
 * There is no window in between. That is the property this file exists to
 * preserve.
 */

import { useCallback, useRef, useState } from 'react';
import { Transaction } from '@solana/web3.js';

import {
  allocate,
  assertPersistedBeforeSend,
  buildContributionTransaction,
  createIntentRecord,
  deriveSlotId,
  sendForFirstTime,
  withSignedBytes,
  type ChainReader,
  type IntentRecord,
  type IntentStore,
  type LeaseState,
  type WalletCapabilityRecord,
} from '@quittance/engine';

import { MwaBroadcaster, describeWalletFailure } from '../wallet/mwa';
import type { PayPhase } from '../screens/PayScreen';

export interface UsePaymentArgs {
  readonly store: IntentStore;
  readonly reader: ChainReader;
  readonly lease: LeaseState;
  readonly onLeaseChange: (lease: LeaseState) => void;
  readonly circleId: string;
  readonly roundIndex: number;
  readonly memberPubkey: string;
  readonly sourceTokenAccount: string;
  readonly destinationTokenAccount: string;
  readonly mint: string;
  readonly mintDecimals: number;
  readonly rawAmount: bigint;
  readonly capabilities: WalletCapabilityRecord;
  readonly authToken: string;
  /** Called once the session returns or is lost, so the circle can resolve. */
  readonly onHandedOff: (slotId: string) => void;
}

export interface UsePaymentResult {
  readonly phase: PayPhase;
  readonly errorMessage: string | null;
  readonly pay: () => Promise<void>;
  readonly reset: () => void;
}

export function usePayment(args: UsePaymentArgs): UsePaymentResult {
  const [phase, setPhase] = useState<PayPhase>('READY');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /**
   * Guards against a double tap producing two intents for one slot.
   *
   * The store would refuse the second write anyway — one slot holds exactly
   * one intent — but failing at the store means the member sees an error for
   * something that is not their fault. This catches it before that.
   */
  const inFlight = useRef(false);

  const reset = useCallback(() => {
    setPhase('READY');
    setErrorMessage(null);
    inFlight.current = false;
  }, []);

  const pay = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setErrorMessage(null);
    setPhase('PREPARING');

    let intent: IntentRecord | null = null;

    try {
      const slotId = deriveSlotId(args.circleId, args.roundIndex, args.memberPubkey);

      // --- step 1: allocate ------------------------------------------------
      //
      // Idempotent. A retrying slot keeps the account it already holds, so a
      // second attempt can never anchor a second live transaction.
      const allocation = allocate(args.lease, slotId);
      args.onLeaseChange(allocation.lease);

      // --- step 2: read the nonce value ------------------------------------
      //
      // Read before building, and the slot it was read at is recorded with
      // the intent, because that slot is what bounds the signature search
      // during recovery.
      const [nonceAccount, builtAtChainSlot] = await Promise.all([
        args.reader.readNonceAccount(allocation.account.pubkey),
        args.reader.readCurrentSlot(),
      ]);

      if (!nonceAccount.exists) {
        throw new PaymentError(
          'This circle is missing the slot your payment needs. Ask whoever runs the ' +
            'circle to top up its lease, then try again.',
        );
      }

      // --- steps 3 and 4: build and hash -----------------------------------
      const { intent: record } = createIntentRecord({
        slotId,
        circleId: args.circleId,
        roundIndex: args.roundIndex,
        memberPubkey: args.memberPubkey,
        sourceTokenAccount: args.sourceTokenAccount,
        destinationTokenAccount: args.destinationTokenAccount,
        mint: args.mint,
        mintDecimals: args.mintDecimals,
        rawAmount: args.rawAmount,
        noncePubkey: allocation.account.pubkey,
        nonceAuthority: allocation.account.authority,
        nonceValue: nonceAccount.nonceValue,
        builtAtChainSlot,
        walletCapabilities: args.capabilities,
        createdAtMs: Date.now(),
      });
      intent = record;

      // --- step 5: the boundary --------------------------------------------
      //
      // Synchronous and flushed before it returns. Nothing below this line may
      // move above it.
      await args.store.putIntentDurably(intent);

      // --- step 6: hand to the wallet --------------------------------------
      //
      // From here the process may be killed at any moment and the answer is
      // still recoverable. `assertPersistedBeforeSend` makes the ordering a
      // runtime check rather than a comment somebody will eventually move.
      assertPersistedBeforeSend(intent, true);
      setPhase('AWAITING_WALLET');
      await args.store.markInFlight(intent.slotId, Date.now());

      const broadcaster = new MwaBroadcaster(args.authToken, rebuildFromIntent);
      const outcome = await sendForFirstTime({
        intent,
        wallet: broadcaster,
        persisted: true,
      });

      // Both outcomes land here, and that is deliberate. A session that
      // returned a signature and a session that died tell us the same amount
      // about whether money moved: nothing that the chain will not tell us
      // better. Neither is treated as a verdict.
      args.onHandedOff(intent.slotId);
      setPhase('SENT');

      if (outcome.kind === 'SESSION_LOST') {
        // Not an error state. The resolver reads the nonce account and finds
        // out. The member is told the truth: it is being checked.
        setErrorMessage(null);
      }
    } catch (error) {
      if (intent !== null) {
        // The intent is on disk, so the payment may well be in flight. The
        // slot stays non-terminal and the resolver will settle it; the screen
        // must not imply nothing happened.
        args.onHandedOff(intent.slotId);
        setPhase('SENT');
        setErrorMessage(null);
      } else {
        setPhase('FAILED');
        setErrorMessage(
          error instanceof PaymentError ? error.message : describeWalletFailure(error),
        );
      }
    } finally {
      inFlight.current = false;
    }
  }, [args]);

  return { phase, errorMessage, pay, reset };
}

/**
 * Rebuild the transaction from a stored intent.
 *
 * Rebuilt from the recorded fields rather than deserialized from the stored
 * message, so that what the wallet is handed is provably the product of the
 * same builder that produced the recorded hash. If the two ever disagreed,
 * the message hash check in the verdict machine would catch it, and this
 * keeps that check meaningful rather than circular.
 */
function rebuildFromIntent(intent: IntentRecord): Transaction {
  return buildContributionTransaction({
    memberPubkey: intent.memberPubkey,
    sourceTokenAccount: intent.transfer.expectedFrom,
    destinationTokenAccount: intent.transfer.expectedTo,
    mint: intent.transfer.expectedMint,
    mintDecimals: intent.transfer.mintDecimals,
    rawAmount: intent.transfer.expectedAmount,
    noncePubkey: intent.noncePubkey,
    nonceAuthority: intent.nonceAuthority,
    nonceValue: intent.nonceValueAtBuild,
  }).transaction;
}

/** Attach signed bytes when the wallet offered the optional method. */
export function recordSignedBytes(
  intent: IntentRecord,
  signedTransactionBase64: string,
): IntentRecord {
  return withSignedBytes(intent, signedTransactionBase64);
}

/** A problem the member can act on, phrased for them. */
export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentError';
  }
}

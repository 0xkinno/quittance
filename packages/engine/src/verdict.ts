/**
 * THE VERDICT MACHINE.
 *
 * This is the core of the product, and it is a pure function. It takes an
 * intent that was recorded before the wallet was opened, and a snapshot of
 * chain state, and it returns what the chain decided.
 *
 * Four properties are load-bearing and each one is enforced by construction
 * rather than by convention:
 *
 *   1. It never guesses. `AMBIGUOUS` is a first-class, shippable outcome
 *      carrying a named reason. A machine that always produces a confident
 *      answer is a machine that is sometimes confidently wrong.
 *
 *   2. It is pure. No network, no React, no logging, no clock of its own —
 *      the observation time arrives inside the snapshot. The app and the
 *      offline verifier call this identical function and must agree.
 *
 *   3. `NOT_SENT` permits rebroadcast of identical bytes only. It never
 *      authorizes rebuilding against a fresh nonce.
 *
 *   4. No state moves backwards out of a terminal state. `resolve` is only
 *      ever called on non-terminal slots, and `assertNoRegression` makes a
 *      violation loud rather than silent.
 */

import { digestsEqual, hashCompiledMessageBase64 } from './canonical.ts';
import type {
  AmbiguityReason,
  Base58Signature,
  ChainSnapshot,
  ContributionState,
  IntentRecord,
  SignatureEntry,
  TransactionSnapshot,
  Verdict,
  VerdictEvidence,
} from './types.ts';
import { isTerminal } from './types.ts';

// ---------------------------------------------------------------------------
// Verdict construction
// ---------------------------------------------------------------------------

interface VerdictDraft {
  readonly state: ContributionState;
  readonly reason: AmbiguityReason | null;
  readonly step: 1 | 2 | 3 | 4 | 5;
  readonly evidence: Partial<VerdictEvidence>;
  /**
   * Whether the I2 balance corroboration actually ran and agreed. Only ever
   * `true` on a `SETTLED` verdict that reached step 5 with a delta present.
   */
  readonly corroborated: boolean;
}

function buildVerdict(
  intent: IntentRecord,
  snapshot: ChainSnapshot,
  draft: VerdictDraft,
): Verdict {
  const evidence: VerdictEvidence = {
    observedNonceValue: draft.evidence.observedNonceValue ?? null,
    consumingSignature: draft.evidence.consumingSignature ?? null,
    consumingSlot: draft.evidence.consumingSlot ?? null,
    observedMessageHash: draft.evidence.observedMessageHash ?? null,
    expectedMessageHash: intent.messageHash,
    expectedRawAmount: intent.transfer.expectedAmount,
    observedRawDelta: draft.evidence.observedRawDelta ?? null,
    programLogs: draft.evidence.programLogs ?? [],
    transactionError: draft.evidence.transactionError ?? null,
  };

  return {
    slotId: intent.slotId,
    state: draft.state,
    reason: draft.reason,
    terminal: isTerminal(draft.state),
    safeToRebroadcastIdenticalBytes: draft.state === 'NOT_SENT',
    evidence,
    decidedAtStep: draft.step,
    decidedAtSlot: snapshot.observedAtSlot,
    decidedAtMs: snapshot.observedAtMs,
    i2Corroborated: draft.corroborated,
  };
}

// ---------------------------------------------------------------------------
// Candidate selection — step 2's "the signature whose slot bounds the advance"
// ---------------------------------------------------------------------------

/**
 * Pick the transaction that consumed the recorded nonce value.
 *
 * The reasoning, which is the part that matters:
 *
 * The nonce value `N` was read at `builtAtChainSlot`. It stayed `N` from that
 * slot until something advanced it. So the transaction that consumed `N` is
 * the *first* one at or after `builtAtChainSlot`. Anything earlier was
 * already reflected in the read.
 *
 * There is one refinement, and it is a strengthening rather than a fudge. A
 * transaction whose compiled message hashes to the recorded hash is proof on
 * its own that the recorded transaction was processed — because the recorded
 * nonce value is a field *inside* that message, and the runtime admits a
 * nonce transaction only while the account's stored nonce equals that field
 * (`docs/runtime-citations.md`, C2). So if any candidate in range matches the
 * recorded hash, that candidate is definitively the consumer, regardless of
 * ordering races in the slot bound. Only when no candidate matches does the
 * first-in-range candidate stand as the foreign consumer.
 */
export function selectConsumingSignature(
  intent: IntentRecord,
  snapshot: ChainSnapshot,
): {
  readonly inRange: readonly SignatureEntry[];
  readonly matched: SignatureEntry | null;
  readonly firstInRange: SignatureEntry | null;
} {
  const inRange = snapshot.nonceSignatures
    .filter((entry) => entry.slot >= intent.builtAtChainSlot)
    .slice()
    .sort((a, b) => (a.slot === b.slot ? a.signature.localeCompare(b.signature) : a.slot - b.slot));

  let matched: SignatureEntry | null = null;
  for (const entry of inRange) {
    const transaction = snapshot.transactions[entry.signature];
    if (transaction === undefined || !transaction.available) continue;
    const observedHash = hashCompiledMessageBase64(transaction.messageBase64);
    if (digestsEqual(observedHash, intent.messageHash)) {
      matched = entry;
      break;
    }
  }

  return { inRange, matched, firstInRange: inRange[0] ?? null };
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

/**
 * Resolve one contribution slot against one chain snapshot.
 *
 * Steps are numbered to match Section 7 of the build instruction and the
 * `decidedAtStep` field on the returned verdict, so every row in the evidence
 * log says which test produced it.
 */
export function resolveVerdict(intent: IntentRecord, snapshot: ChainSnapshot): Verdict {
  // ---- STEP 1 — read the nonce account -----------------------------------
  //
  // This is the whole oracle. One account read, no signature, no wallet, no
  // local secret. It answers correctly after process death, after a reboot,
  // and after arbitrary offline time, because a durable nonce transaction is
  // exempt from blockhash expiry (C1).

  if (!snapshot.nonceAccount.exists) {
    return buildVerdict(intent, snapshot, {
      state: 'AMBIGUOUS',
      reason: 'NONCE_ACCOUNT_GONE',
      step: 1,
      evidence: {},
      corroborated: false,
    });
  }

  const observedNonceValue = snapshot.nonceAccount.nonceValue;

  if (observedNonceValue === intent.nonceValueAtBuild) {
    // The stored nonce is still the value the transaction was built against.
    // The runtime cannot have processed that transaction, because processing
    // it advances this account before execution (C2). This is terminal and
    // it is the one verdict that authorizes rebroadcast.
    return buildVerdict(intent, snapshot, {
      state: 'NOT_SENT',
      reason: null,
      step: 1,
      evidence: { observedNonceValue },
      corroborated: false,
    });
  }

  // ---- STEP 2 — find the transaction that consumed the nonce -------------

  const { inRange, matched, firstInRange } = selectConsumingSignature(intent, snapshot);

  if (snapshot.nonceSignatures.length === 0 || inRange.length === 0) {
    // The nonce advanced, so something consumed it, and the node cannot show
    // us what. Guessing here would violate I1 in one direction and I2 in the
    // other, so it escalates with the reason named.
    return buildVerdict(intent, snapshot, {
      state: 'AMBIGUOUS',
      reason: 'BEYOND_RETENTION',
      step: 2,
      evidence: { observedNonceValue },
      corroborated: false,
    });
  }

  const candidate: SignatureEntry = matched ?? (firstInRange as SignatureEntry);
  const transaction: TransactionSnapshot | undefined = snapshot.transactions[candidate.signature];

  if (transaction === undefined || !transaction.available) {
    // A signature exists and the node will not return the transaction, so the
    // message hash cannot be compared. Not settled, not unsent, escalated.
    return buildVerdict(intent, snapshot, {
      state: 'AMBIGUOUS',
      reason: 'TRANSACTION_UNAVAILABLE',
      step: 2,
      evidence: {
        observedNonceValue,
        consumingSignature: candidate.signature,
        consumingSlot: candidate.slot,
      },
      corroborated: false,
    });
  }

  // ---- STEP 3 — recompute the message hash from chain data ---------------
  //
  // Recomputed, never trusted. The hash is taken over the message bytes the
  // node returned, not over anything the app kept, so a tampered local record
  // cannot talk the machine into a verdict.

  const observedMessageHash = hashCompiledMessageBase64(transaction.messageBase64);
  const sharedEvidence = {
    observedNonceValue,
    consumingSignature: candidate.signature as Base58Signature,
    consumingSlot: candidate.slot,
    observedMessageHash,
    programLogs: transaction.logs,
  };

  if (!digestsEqual(observedMessageHash, intent.messageHash)) {
    // Something else consumed this nonce. The recorded transaction can now
    // never land, and we must not assume it did or did not pay. This is the
    // F8 fault and it escalates with full evidence attached.
    return buildVerdict(intent, snapshot, {
      state: 'AMBIGUOUS',
      reason: 'FOREIGN_CONSUMER',
      step: 3,
      evidence: {
        ...sharedEvidence,
        transactionError: transaction.err,
        observedRawDelta: transaction.destinationRawDelta,
      },
      corroborated: false,
    });
  }

  // ---- STEP 4 — the transaction is ours; did it succeed? -----------------
  //
  // This is the three-state nuance. The nonce advances even when the
  // transfer fails, because the runtime rolls the account back and then
  // stores the advanced value to prevent replay of a failed nonce
  // transaction (C3, C4). "Advanced" means processed, not paid.

  if (transaction.err !== null && transaction.err !== undefined) {
    return buildVerdict(intent, snapshot, {
      state: 'REJECTED',
      reason: null,
      step: 4,
      evidence: {
        ...sharedEvidence,
        transactionError: transaction.err,
        observedRawDelta: transaction.destinationRawDelta,
      },
      corroborated: false,
    });
  }

  // ---- STEP 5 — corroborate against the destination balance delta --------
  //
  // The transaction is ours and it succeeded. One more independent check
  // before money is called moved: the destination token account must have
  // gained exactly the expected amount.

  const observedRawDelta = transaction.destinationRawDelta;

  if (observedRawDelta !== null && observedRawDelta !== intent.transfer.expectedAmount) {
    return buildVerdict(intent, snapshot, {
      state: 'AMBIGUOUS',
      reason: 'BALANCE_DISAGREES',
      step: 5,
      evidence: { ...sharedEvidence, observedRawDelta, transactionError: null },
      corroborated: false,
    });
  }

  // A `null` delta means the node did not return token balances for this
  // transaction. The verdict is still `SETTLED` — the transaction is provably
  // ours and provably succeeded — but it is recorded as uncorroborated, and
  // the I2 predicate reports uncorroborated settlements separately rather
  // than counting them as a clean pass. The machine does not pretend a check
  // ran that did not run.
  return buildVerdict(intent, snapshot, {
    state: 'SETTLED',
    reason: null,
    step: 5,
    evidence: { ...sharedEvidence, observedRawDelta, transactionError: null },
    corroborated: observedRawDelta !== null,
  });
}

// ---------------------------------------------------------------------------
// Regression guard — rule 4
// ---------------------------------------------------------------------------

/**
 * Thrown when a verdict would move a slot out of a terminal state.
 *
 * This is deliberately an exception rather than a returned error. A terminal
 * state moving backwards is not a condition to handle gracefully, it is a bug
 * in the caller, and it must stop the resolver rather than be written to the
 * store.
 */
export class TerminalRegressionError extends Error {
  readonly slotId: string;
  readonly from: ContributionState;
  readonly to: ContributionState;

  constructor(slotId: string, from: ContributionState, to: ContributionState) {
    super(
      `Slot ${slotId} is terminal in state ${from} and a verdict of ${to} was offered. ` +
        'Terminal states never move. This is a caller bug, not a chain condition.',
    );
    this.name = 'TerminalRegressionError';
    this.slotId = slotId;
    this.from = from;
    this.to = to;
  }
}

/**
 * Assert that applying `next` to a slot currently in `current` is legal.
 *
 * Re-asserting the same terminal state is permitted and is a no-op, because
 * the resolver is idempotent by design: running it twice over the same
 * snapshot must produce the same store.
 */
export function assertNoRegression(
  slotId: string,
  current: ContributionState,
  next: ContributionState,
): void {
  if (!isTerminal(current)) return;
  if (current === next) return;
  throw new TerminalRegressionError(slotId, current, next);
}

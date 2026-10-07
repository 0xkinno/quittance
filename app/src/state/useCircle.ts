/**
 * Circle state.
 *
 * Holds the member list, the current round, and every contribution slot's
 * state — and keeps that state honest, which is the only interesting thing
 * this hook does.
 *
 * The rule it enforces: **a row is never shown as a fact until the chain has
 * been read.** On launch, and on every resume, the resolver walks every
 * non-terminal slot to a terminal one before the rows are treated as current.
 * Until then the screen says it is checking. An app that rendered its last
 * known state as though it were the truth would be making exactly the mistake
 * this product exists to eliminate — the phone deciding what happened.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';

import {
  medianTimeToVerdictMs,
  resolveAllOutstanding,
  type ChainReader,
  type ContributionState,
  type IntentStore,
  type RawBroadcaster,
  type ResolutionReport,
  type StoredSlot,
  type WalletBroadcaster,
} from '@quittance/engine';

export interface CircleMember {
  readonly pubkey: string;
  readonly name: string;
}

export interface CircleDefinition {
  readonly circleId: string;
  readonly name: string;
  readonly members: readonly CircleMember[];
  /** Indices into `members`, giving who collects in which round. */
  readonly rotationOrder: readonly number[];
  readonly contributionRaw: bigint;
  readonly mintDecimals: number;
  readonly roundCount: number;
}

export interface UseCircleArgs {
  readonly definition: CircleDefinition;
  readonly store: IntentStore;
  readonly reader: ChainReader;
  readonly roundIndex: number;
  readonly youPubkey: string;
  readonly wallet: WalletBroadcaster | null;
  readonly raw: RawBroadcaster | null;
}

export interface CircleRow {
  readonly memberPubkey: string;
  readonly name: string;
  readonly state: ContributionState;
  readonly isYou: boolean;
}

export interface UseCircleResult {
  readonly rows: readonly CircleRow[];
  readonly slots: readonly StoredSlot[];
  readonly recipientName: string;
  /** True while the first resolve pass since launch or resume is running. */
  readonly isResolving: boolean;
  readonly isRefreshing: boolean;
  /** Set when the chain could not be read. Never replaced with a guess. */
  readonly readError: string | null;
  readonly lastReport: ResolutionReport | null;
  readonly medianVerdictMs: number | null;
  readonly refresh: () => Promise<void>;
}

export function useCircle(args: UseCircleArgs): UseCircleResult {
  const [slots, setSlots] = useState<readonly StoredSlot[]>([]);
  const [isResolving, setIsResolving] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<ResolutionReport | null>(null);

  /** Stops two resolve passes overlapping on a fast resume-then-pull. */
  const running = useRef(false);

  const resolve = useCallback(
    async (showSpinner: boolean) => {
      if (running.current) return;
      running.current = true;
      if (showSpinner) setIsResolving(true);

      try {
        const report = await resolveAllOutstanding(args.reader, args.store, {
          // The member is present and looking at the screen, so a slot the
          // chain proves was never sent is finished rather than left for them
          // to tap again.
          rebroadcastNotSent: false,
          raw: args.raw,
          wallet: args.wallet,
        });

        setLastReport(report);
        setSlots(await args.store.listSlots());

        // One unreadable slot does not invalidate the others, so the error is
        // reported alongside the rows that did resolve rather than instead of
        // them.
        setReadError(
          report.unresolvedCount === 0
            ? null
            : `${report.unresolvedCount} ${
                report.unresolvedCount === 1 ? 'payment' : 'payments'
              } could not be checked just now. Nothing has been recorded for ${
                report.unresolvedCount === 1 ? 'it' : 'them'
              }, and Quittance will try again.`,
        );
      } catch (error) {
        setReadError(
          error instanceof Error
            ? `Quittance could not reach the network. ${error.message}`
            : 'Quittance could not reach the network.',
        );
        setSlots(await args.store.listSlots());
      } finally {
        running.current = false;
        setIsResolving(false);
        setIsRefreshing(false);
      }
    },
    [args.reader, args.store, args.raw, args.wallet],
  );

  // On launch.
  useEffect(() => {
    void resolve(true);
  }, [resolve]);

  // On resume. This is the path a member takes after their phone killed the
  // app mid-payment, so it has to re-read rather than trust what is in memory.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') void resolve(true);
    });
    return () => {
      subscription.remove();
    };
  }, [resolve]);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    await resolve(false);
  }, [resolve]);

  const rows = args.definition.members.map((member) => {
    const slot = slots.find(
      (candidate) =>
        candidate.intent.memberPubkey === member.pubkey &&
        candidate.intent.roundIndex === args.roundIndex,
    );
    return {
      memberPubkey: member.pubkey,
      name: member.name,
      // No slot means nothing has been built for this member this round, which
      // is exactly "not paid" and is shown as such.
      state: slot?.state ?? ('NOT_SENT' as ContributionState),
      isYou: member.pubkey === args.youPubkey,
    };
  });

  const recipientIndex =
    args.definition.rotationOrder[args.roundIndex % args.definition.rotationOrder.length] ?? 0;
  const recipientName = args.definition.members[recipientIndex]?.name ?? 'the next member';

  return {
    rows,
    slots,
    recipientName,
    isResolving,
    isRefreshing,
    readError,
    lastReport,
    medianVerdictMs: lastReport === null ? null : medianTimeToVerdictMs(lastReport),
    refresh,
  };
}

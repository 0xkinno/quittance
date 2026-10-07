/**
 * Collection day.
 *
 * The organizer's view. Every member, every terminal state, and one payout
 * button that is disabled with a stated reason while anything is unresolved.
 *
 * This screen is where invariant I3 — a round cannot disburse while any
 * contribution slot is non-terminal — stops being a line in a document and
 * becomes something Adaeze reads. The button does not sit there grey and
 * silent; it says exactly which contributions are still open and what has to
 * happen before the pot can move.
 *
 * It is worth being clear about what this screen does **not** do. It does not
 * let the organizer mark someone paid to unblock a payout. The only path out
 * of an unresolved contribution is the resolve screen, which records an
 * attributed human decision, and even then the program refuses to credit a
 * settlement the vault does not actually hold.
 */

import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { isTerminal, type ContributionState } from '@quittance/engine';
import { LedgerRow } from '../components/LedgerRow';
import { PrimaryButton } from '../components/PrimaryButton';
import { formatAmount, space, type Palette } from '../design/tokens';

export interface CollectionMember {
  readonly memberPubkey: string;
  readonly name: string;
  readonly state: ContributionState;
}

export interface CollectionDayScreenProps {
  readonly circleName: string;
  readonly roundIndex: number;
  readonly recipientName: string;
  readonly contributionRaw: bigint;
  readonly decimals: number;
  readonly members: readonly CollectionMember[];
  readonly colors: Palette;
  readonly alreadyDisbursed: boolean;
  readonly busy: boolean;
  readonly errorMessage: string | null;
  readonly onPayOut: () => void;
  readonly onResolvePress: (memberPubkey: string) => void;
  readonly onBack: () => void;
}

export function CollectionDayScreen(
  props: CollectionDayScreenProps,
): React.JSX.Element {
  const { colors, members } = props;

  const open = useMemo(
    () => members.filter((member) => !isTerminal(member.state)),
    [members],
  );
  const needsDecision = useMemo(
    () => members.filter((member) => member.state === 'AMBIGUOUS'),
    [members],
  );
  const settled = useMemo(
    () => members.filter((member) => member.state === 'SETTLED'),
    [members],
  );

  const potRaw = BigInt(settled.length) * props.contributionRaw;
  const blockedReason = payoutBlockedReason(open, needsDecision);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.paper }]} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.title, { color: colors.ink }]}>Collection day</Text>
        <Text style={[styles.subhead, { color: colors.inkSoft }]}>
          {props.circleName} · week {props.roundIndex + 1} · {props.recipientName} collects
        </Text>

        <View style={[styles.ledger, { borderTopColor: colors.rule }]}>
          {members.map((member, index) => (
            <LedgerRow
              key={member.memberPubkey}
              name={member.name}
              rawAmount={props.contributionRaw}
              decimals={props.decimals}
              state={member.state}
              colors={colors}
              isLast={index === members.length - 1}
              onPress={
                member.state === 'AMBIGUOUS'
                  ? () => props.onResolvePress(member.memberPubkey)
                  : undefined
              }
            />
          ))}
        </View>

        <View style={[styles.pot, { borderTopColor: colors.rule }]}>
          <Text style={[styles.potLabel, { color: colors.inkSoft }]}>
            {settled.length} of {members.length} paid
          </Text>
          <Text style={[styles.potAmount, { color: colors.ink }]}>
            {formatAmount(potRaw, props.decimals)}
          </Text>
        </View>

        {props.errorMessage !== null ? (
          <Text style={[styles.error, { color: colors.rejected }]}>{props.errorMessage}</Text>
        ) : null}

        <View style={styles.actions}>
          {props.alreadyDisbursed ? (
            <Text style={[styles.done, { color: colors.settled }]}>
              This week has been paid out to {props.recipientName}. A round pays out once,
              and the chain will refuse a second attempt.
            </Text>
          ) : (
            <PrimaryButton
              label={`Pay out to ${props.recipientName}`}
              onPress={props.onPayOut}
              colors={colors}
              busy={props.busy}
              disabled={blockedReason !== null}
              disabledReason={blockedReason ?? undefined}
            />
          )}

          <PrimaryButton
            label="Back"
            onPress={props.onBack}
            colors={colors}
            variant="secondary"
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Why the payout is off, as a sentence.
 *
 * Returns `null` when the payout may proceed. This is invariant I3 stated in
 * the one place a person needs it, and it names the specific people rather
 * than reporting a count, because "Ngozi and Emeka" is actionable and
 * "2 contributions" is not.
 */
function payoutBlockedReason(
  open: readonly CollectionMember[],
  needsDecision: readonly CollectionMember[],
): string | null {
  if (needsDecision.length > 0) {
    const names = joinNames(needsDecision.map((member) => member.name));
    return `${names} ${needsDecision.length === 1 ? 'needs' : 'need'} a decision before anything pays out. Tap the row to settle it.`;
  }
  if (open.length > 0) {
    const names = joinNames(open.map((member) => member.name));
    return `Still waiting on ${names}. Nothing pays out until every contribution is settled one way or the other.`;
  }
  return null;
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] as string;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { paddingBottom: space.xxxl },
  title: {
    fontFamily: 'Fraunces',
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.4,
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
  },
  subhead: {
    fontFamily: 'Geist',
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: space.lg,
    paddingTop: space.xs,
    paddingBottom: space.xl,
  },
  ledger: { borderTopWidth: StyleSheet.hairlineWidth },
  pot: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    gap: space.xs,
  },
  potLabel: { fontFamily: 'Geist', fontSize: 14, lineHeight: 20 },
  potAmount: {
    fontFamily: 'GeistMono',
    fontSize: 34,
    lineHeight: 42,
    fontVariant: ['tabular-nums'],
  },
  error: {
    fontFamily: 'Geist',
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },
  actions: {
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    gap: space.md,
  },
  done: { fontFamily: 'Geist', fontSize: 15, lineHeight: 23 },
});

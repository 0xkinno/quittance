/**
 * The circle. The home screen.
 *
 * Twelve rows, each a member, each either paid or not. This is the screen
 * that replaces a paper notebook, a WhatsApp group full of bank-transfer
 * screenshots, and two hours of cross-checking on collection day.
 *
 * It is deliberately almost empty. There is a heading, a ruled list, a line
 * of counts, and one button. No cards, no charts, no balance hero, no
 * blockchain word anywhere on it. The product's claim is that opening this
 * screen is already enough to know where everyone stands, and anything added
 * to it would be arguing against that claim.
 */

import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ContributionState } from '@quittance/engine';
import { LedgerRow } from '../components/LedgerRow';
import { PrimaryButton } from '../components/PrimaryButton';
import { formatAmount, space, type Palette } from '../design/tokens';

export interface CircleMemberRow {
  readonly memberPubkey: string;
  readonly name: string;
  readonly state: ContributionState;
  readonly isYou: boolean;
}

export interface CircleScreenProps {
  readonly circleName: string;
  readonly roundIndex: number;
  readonly roundCount: number;
  readonly recipientName: string;
  readonly contributionRaw: bigint;
  readonly decimals: number;
  readonly members: readonly CircleMemberRow[];
  readonly colors: Palette;
  readonly isRefreshing: boolean;
  readonly onRefresh: () => void;
  readonly onPayPress: () => void;
  readonly onMemberPress: (memberPubkey: string) => void;
  readonly onCollectionDayPress: () => void;
  /** Set while the first resolve pass after launch is still running. */
  readonly isResolving: boolean;
  /** Non-null when the chain could not be reached. Never a guess. */
  readonly readError: string | null;
}

export function CircleScreen(props: CircleScreenProps): React.JSX.Element {
  const { colors, members } = props;

  const counts = useMemo(() => tally(members), [members]);
  const you = members.find((member) => member.isYou);
  const youOwe = you !== undefined && (you.state === 'NOT_SENT' || you.state === 'DRAFTED');

  const total = BigInt(counts.settled) * props.contributionRaw;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.paper }]} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={props.isRefreshing}
            onRefresh={props.onRefresh}
            tintColor={colors.inkSoft}
          />
        }
      >
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.ink }]}>{props.circleName}</Text>
          <Text style={[styles.week, { color: colors.inkSoft }]}>
            Week {props.roundIndex + 1} of {props.roundCount}
          </Text>
        </View>

        <Text style={[styles.subhead, { color: colors.inkSoft }]}>
          {props.recipientName} collects this week
        </Text>

        {/* The resolve pass is the one thing allowed to interrupt this screen,
            because until it finishes the rows are last known rather than
            current, and showing a stale row as fact is the exact failure this
            product refuses to make. */}
        {props.isResolving ? (
          <View style={[styles.notice, { backgroundColor: colors.paperSunk }]}>
            <ActivityIndicator size="small" color={colors.inflight} />
            <Text style={[styles.noticeText, { color: colors.inkSoft }]}>
              Checking where every payment stands
            </Text>
          </View>
        ) : null}

        {props.readError !== null ? (
          <View style={[styles.notice, { backgroundColor: colors.paperSunk }]}>
            <Text style={[styles.noticeText, { color: colors.ambiguous }]}>
              {props.readError}
            </Text>
          </View>
        ) : null}

        <View style={[styles.ledger, { borderTopColor: colors.rule }]}>
          {members.map((member, index) => (
            <LedgerRow
              key={member.memberPubkey}
              name={member.name}
              rawAmount={props.contributionRaw}
              decimals={props.decimals}
              state={member.state}
              colors={colors}
              isYou={member.isYou}
              isLast={index === members.length - 1}
              onPress={() => props.onMemberPress(member.memberPubkey)}
            />
          ))}
        </View>

        <View style={[styles.summary, { borderTopColor: colors.rule }]}>
          <Text style={[styles.summaryLine, { color: colors.inkSoft }]}>
            {summarySentence(counts, members.length)}
          </Text>
          <Text style={[styles.total, { color: colors.ink }]}>
            {formatAmount(total, props.decimals)} collected
          </Text>
        </View>

        <View style={styles.actions}>
          {youOwe ? (
            <PrimaryButton
              label="Pay this week"
              onPress={props.onPayPress}
              colors={colors}
            />
          ) : null}
          <PrimaryButton
            label="Collection day"
            onPress={props.onCollectionDayPress}
            colors={colors}
            variant="secondary"
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

interface Tally {
  readonly settled: number;
  readonly inFlight: number;
  readonly ambiguous: number;
  readonly rejected: number;
  readonly outstanding: number;
}

function tally(members: readonly CircleMemberRow[]): Tally {
  let settled = 0;
  let inFlight = 0;
  let ambiguous = 0;
  let rejected = 0;
  let outstanding = 0;

  for (const member of members) {
    switch (member.state) {
      case 'SETTLED':
        settled += 1;
        break;
      case 'IN_FLIGHT':
        inFlight += 1;
        break;
      case 'AMBIGUOUS':
        ambiguous += 1;
        break;
      case 'REJECTED':
        rejected += 1;
        break;
      default:
        outstanding += 1;
    }
  }

  return { settled, inFlight, ambiguous, rejected, outstanding };
}

/**
 * The counts line, written as a sentence rather than a row of chips.
 *
 * Clauses are omitted when their count is zero, so a clean week reads
 * "12 of 12 paid" and nothing else. A status line that always shows every
 * category trains people to stop reading it.
 */
function summarySentence(counts: Tally, total: number): string {
  const parts: string[] = [`${counts.settled} of ${total} paid`];
  if (counts.inFlight > 0) parts.push(`${counts.inFlight} sending`);
  if (counts.ambiguous > 0) {
    parts.push(
      counts.ambiguous === 1 ? '1 needs a decision' : `${counts.ambiguous} need a decision`,
    );
  }
  if (counts.rejected > 0) parts.push(`${counts.rejected} did not go through`);
  return parts.join(' · ');
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { paddingBottom: space.xxxl },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
  },
  title: {
    fontFamily: 'Fraunces',
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.4,
    flexShrink: 1,
  },
  week: {
    fontFamily: 'GeistMono',
    fontSize: 13,
    lineHeight: 19,
    fontVariant: ['tabular-nums'],
  },
  subhead: {
    fontFamily: 'Geist',
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: space.lg,
    paddingTop: space.xs,
    paddingBottom: space.xl,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.lg,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  noticeText: {
    fontFamily: 'Geist',
    fontSize: 14,
    lineHeight: 20,
    flexShrink: 1,
  },
  ledger: { borderTopWidth: StyleSheet.hairlineWidth },
  summary: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    gap: space.xs,
  },
  summaryLine: { fontFamily: 'Geist', fontSize: 14, lineHeight: 20 },
  total: {
    fontFamily: 'GeistMono',
    fontSize: 16,
    lineHeight: 22,
    fontVariant: ['tabular-nums'],
  },
  actions: {
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    gap: space.md,
  },
});

/**
 * Proof.
 *
 * The judge page, inside the app. Campaign results, the invariant checks,
 * explorer links, and the command a skeptic runs to reproduce all of it
 * without this app, this phone, or any wallet.
 *
 * Two rules govern this screen absolutely:
 *
 *   **Every number here comes from a generated evidence file.** Nothing on
 *   this screen is typed by hand, and nothing is computed in the component.
 *   If `evidence/campaign.json` does not exist, the screen says the campaign
 *   has not been run — it does not show zeroes, and it does not show a
 *   plausible-looking placeholder. A screen that invents a number to avoid
 *   looking empty is exactly the failure mode this product is about.
 *
 *   **The two arms are never pooled.** The baseline arm and the Quittance arm
 *   ran the identical fault corpus on the same device, and they are reported
 *   side by side. If the baseline shows zero double debits, this screen says
 *   so, because a control that could have disproved the claim is the reason
 *   the claim is believable.
 */

import React from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '../components/PrimaryButton';
import { space, type Palette } from '../design/tokens';

export interface InvariantSummary {
  readonly id: string;
  readonly title: string;
  readonly pass: boolean;
  readonly checked: number;
  readonly violations: number;
}

export interface ArmSummary {
  readonly doubleDebits: number;
  readonly unresolvedAfterFiveMinutes: number;
  readonly falsePositiveCredits: number;
  readonly runs: number;
}

export interface CampaignSummary {
  readonly runId: string;
  readonly contributions: number;
  readonly deviceModel: string;
  readonly androidVersion: string;
  readonly walletVersion: string;
  readonly commit: string;
  readonly medianTimeToVerdictMs: number;
  readonly ambiguousEscalations: number;
  readonly quittance: ArmSummary;
  readonly baseline: ArmSummary;
}

export interface ProofScreenProps {
  /** `null` when no campaign has been run. Never substituted with zeroes. */
  readonly campaign: CampaignSummary | null;
  readonly invariants: readonly InvariantSummary[];
  readonly programId: string | null;
  readonly explorerBaseUrl: string;
  readonly verifierCommand: string;
  readonly colors: Palette;
  readonly onBack: () => void;
}

export function ProofScreen(props: ProofScreenProps): React.JSX.Element {
  const { colors, campaign } = props;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.paper }]} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.title, { color: colors.ink }]}>Proof</Text>
        <Text style={[styles.lede, { color: colors.inkSoft }]}>
          Quittance claims a payment can never be taken twice and can never be counted
          without having happened. Here is what was done to try to break that, and what
          the chain says about it.
        </Text>

        {campaign === null ? (
          <View style={[styles.notRun, { backgroundColor: colors.paperSunk }]}>
            <Text style={[styles.notRunTitle, { color: colors.ink }]}>
              The campaign has not been run yet
            </Text>
            <Text style={[styles.notRunBody, { color: colors.inkSoft }]}>
              There are no numbers on this screen because none have been produced. When the
              fault campaign runs on real hardware, every figure here is written by a script
              reading its results file, and none of them is typed by hand.
            </Text>
          </View>
        ) : (
          <>
            <Section title="Both arms, same faults, same phone" colors={colors}>
              <Text style={[styles.body, { color: colors.inkSoft }]}>
                {campaign.contributions} fault-injected contributions on a{' '}
                {campaign.deviceModel} running Android {campaign.androidVersion}, wallet{' '}
                {campaign.walletVersion}. The baseline arm is the standard mobile pattern,
                written honestly: a recent blockhash, one retry, and a history scan on
                recovery. Both arms ran the identical corpus and are never pooled.
              </Text>

              <View style={[styles.table, { borderColor: colors.rule }]}>
                <TableRow
                  cells={['', 'baseline', 'quittance']}
                  colors={colors}
                  isHeader
                />
                <TableRow
                  cells={[
                    'double debits',
                    String(campaign.baseline.doubleDebits),
                    String(campaign.quittance.doubleDebits),
                  ]}
                  colors={colors}
                />
                <TableRow
                  cells={[
                    'unresolved after 5 min',
                    String(campaign.baseline.unresolvedAfterFiveMinutes),
                    String(campaign.quittance.unresolvedAfterFiveMinutes),
                  ]}
                  colors={colors}
                />
                <TableRow
                  cells={[
                    'false credits',
                    String(campaign.baseline.falsePositiveCredits),
                    String(campaign.quittance.falsePositiveCredits),
                  ]}
                  colors={colors}
                  isLast
                />
              </View>

              {/* Stated rather than buried. A control that could have
                  disproved the claim is why the claim is worth anything. */}
              {campaign.baseline.doubleDebits === 0 ? (
                <Text style={[styles.caveat, { color: colors.ambiguous }]}>
                  The baseline arm recorded no double debits in this run. That is reported
                  as it stands rather than tuned, and it weakens the comparison honestly.
                </Text>
              ) : null}
            </Section>

            <Section title="What it cost" colors={colors}>
              <Metric
                label="median time to a final answer"
                value={`${campaign.medianTimeToVerdictMs} ms`}
                colors={colors}
              />
              <Metric
                label="escalated to a person"
                value={String(campaign.ambiguousEscalations)}
                colors={colors}
              />
              <Text style={[styles.caveat, { color: colors.inkSoft }]}>
                Every escalation carries a named reason. Quittance refusing to decide is a
                shipped outcome, not a bug.
              </Text>
            </Section>
          </>
        )}

        <Section title="The six invariants" colors={colors}>
          {props.invariants.length === 0 ? (
            <Text style={[styles.body, { color: colors.inkSoft }]}>
              Not yet checked against a run.
            </Text>
          ) : (
            props.invariants.map((invariant) => (
              <View key={invariant.id} style={styles.invariantRow}>
                <Text
                  style={[
                    styles.invariantMark,
                    { color: invariant.pass ? colors.settled : colors.rejected },
                  ]}
                >
                  {invariant.pass ? 'PASS' : 'FAIL'}
                </Text>
                <View style={styles.invariantText}>
                  <Text style={[styles.invariantTitle, { color: colors.ink }]}>
                    {invariant.id} · {invariant.title}
                  </Text>
                  <Text style={[styles.invariantMeta, { color: colors.inkFaint }]}>
                    {invariant.checked} checked, {invariant.violations} violations
                  </Text>
                </View>
              </View>
            ))
          )}
        </Section>

        <Section title="Check it yourself" colors={colors}>
          <Text style={[styles.body, { color: colors.inkSoft }]}>
            This command re-reads the chain and recomputes every verdict with the same
            function the app used. It needs no wallet, no key, and no part of this app.
          </Text>
          <View style={[styles.command, { backgroundColor: colors.paperSunk }]}>
            <Text style={[styles.commandText, { color: colors.ink }]} selectable>
              {props.verifierCommand}
            </Text>
          </View>
        </Section>

        {props.programId !== null ? (
          <Section title="On chain" colors={colors}>
            <Text
              style={[styles.link, { color: colors.inflight }]}
              onPress={() => {
                void Linking.openURL(
                  `${props.explorerBaseUrl}/address/${props.programId}`,
                );
              }}
              selectable
            >
              {props.programId}
            </Text>
          </Section>
        ) : null}

        <View style={styles.actions}>
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

function Section({
  title,
  colors,
  children,
}: {
  readonly title: string;
  readonly colors: Palette;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={[styles.section, { borderTopColor: colors.rule }]}>
      <Text style={[styles.sectionTitle, { color: colors.ink }]}>{title}</Text>
      {children}
    </View>
  );
}

function Metric({
  label,
  value,
  colors,
}: {
  readonly label: string;
  readonly value: string;
  readonly colors: Palette;
}): React.JSX.Element {
  return (
    <View style={styles.metric}>
      <Text style={[styles.metricLabel, { color: colors.inkSoft }]}>{label}</Text>
      <Text style={[styles.metricValue, { color: colors.ink }]}>{value}</Text>
    </View>
  );
}

function TableRow({
  cells,
  colors,
  isHeader = false,
  isLast = false,
}: {
  readonly cells: readonly string[];
  readonly colors: Palette;
  readonly isHeader?: boolean;
  readonly isLast?: boolean;
}): React.JSX.Element {
  return (
    <View
      style={[
        styles.tableRow,
        { borderBottomColor: isLast ? 'transparent' : colors.rule },
      ]}
    >
      {cells.map((cell, index) => (
        <Text
          key={`${cell}-${index}`}
          style={[
            index === 0 ? styles.tableLabel : styles.tableValue,
            { color: isHeader ? colors.inkFaint : colors.ink },
          ]}
        >
          {cell}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { paddingHorizontal: space.lg, paddingBottom: space.xxxl },
  title: {
    fontFamily: 'Fraunces',
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.4,
    paddingTop: space.xl,
  },
  lede: {
    fontFamily: 'Geist',
    fontSize: 16,
    lineHeight: 24,
    paddingTop: space.sm,
    paddingBottom: space.lg,
  },
  notRun: { padding: space.lg, gap: space.sm },
  notRunTitle: { fontFamily: 'Fraunces', fontSize: 21, lineHeight: 27 },
  notRunBody: { fontFamily: 'Geist', fontSize: 14, lineHeight: 20 },
  section: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space.lg,
    marginTop: space.xl,
    gap: space.md,
  },
  sectionTitle: { fontFamily: 'Fraunces', fontSize: 21, lineHeight: 27 },
  body: { fontFamily: 'Geist', fontSize: 14, lineHeight: 21 },
  caveat: { fontFamily: 'Geist', fontSize: 13, lineHeight: 19 },
  table: { borderWidth: StyleSheet.hairlineWidth },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tableLabel: { fontFamily: 'Geist', fontSize: 13, lineHeight: 19, flex: 1 },
  tableValue: {
    fontFamily: 'GeistMono',
    fontSize: 13,
    lineHeight: 19,
    fontVariant: ['tabular-nums'],
    width: 86,
    textAlign: 'right',
  },
  metric: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  metricLabel: { fontFamily: 'Geist', fontSize: 14, lineHeight: 20, flexShrink: 1 },
  metricValue: {
    fontFamily: 'GeistMono',
    fontSize: 16,
    lineHeight: 22,
    fontVariant: ['tabular-nums'],
  },
  invariantRow: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  invariantMark: {
    fontFamily: 'GeistMono',
    fontSize: 13,
    lineHeight: 19,
    width: 42,
  },
  invariantText: { flex: 1, gap: 2 },
  invariantTitle: { fontFamily: 'Geist', fontSize: 14, lineHeight: 20 },
  invariantMeta: { fontFamily: 'Geist', fontSize: 13, lineHeight: 18 },
  command: { padding: space.md },
  commandText: { fontFamily: 'GeistMono', fontSize: 12, lineHeight: 19 },
  link: { fontFamily: 'GeistMono', fontSize: 13, lineHeight: 19 },
  actions: { paddingTop: space.xxl },
});

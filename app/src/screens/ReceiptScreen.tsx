/**
 * The quittance.
 *
 * A quittance is the formal document certifying that an obligation has been
 * discharged in full. This screen is the product's namesake: one per
 * contribution, shareable, and verifiable by someone who has neither the app
 * nor the phone.
 *
 * The verifiable part is what makes it more than a receipt image. Every
 * quittance carries the account the contribution was anchored to, and from
 * that single public key a stranger can recover whether it happened, which
 * transaction did it, whether that transaction succeeded, and whether its
 * contents match what was recorded before the wallet was ever opened. The
 * share text includes the command that does it.
 *
 * A screenshot of a bank transfer proves nothing and starts arguments. This
 * is the thing that replaces it.
 */

import React from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ContributionState } from '@quittance/engine';
import { PrimaryButton } from '../components/PrimaryButton';
import {
  formatAmount,
  space,
  stateColor,
  stateLabel,
  type Palette,
} from '../design/tokens';

export interface ReceiptScreenProps {
  readonly circleName: string;
  readonly roundIndex: number;
  readonly memberName: string;
  readonly state: ContributionState;
  readonly rawAmount: bigint;
  readonly decimals: number;
  readonly noncePubkey: string;
  readonly consumingSignature: string | null;
  readonly settledAtMs: number | null;
  readonly wasHumanDecision: boolean;
  readonly decidedBy: string | null;
  readonly explorerBaseUrl: string;
  readonly colors: Palette;
  readonly onBack: () => void;
}

export function ReceiptScreen(props: ReceiptScreenProps): React.JSX.Element {
  const { colors } = props;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.paper }]}>
      <View style={styles.body}>
        <Text style={[styles.eyebrow, { color: colors.inkSoft }]}>Quittance</Text>

        <View style={styles.headlineRow}>
          <View
            style={[styles.dot, { backgroundColor: stateColor(props.state, colors) }]}
          />
          <Text style={[styles.headline, { color: colors.ink }]}>
            {stateLabel[props.state]}
          </Text>
        </View>

        <Text style={[styles.amount, { color: colors.ink }]}>
          {formatAmount(props.rawAmount, props.decimals)}
        </Text>

        <Text style={[styles.detail, { color: colors.inkSoft }]}>
          {props.memberName} · {props.circleName} · week {props.roundIndex + 1}
        </Text>

        {props.settledAtMs !== null ? (
          <Text style={[styles.detail, { color: colors.inkSoft }]}>
            {formatTimestamp(props.settledAtMs)}
          </Text>
        ) : null}

        {/* A human override is never dressed up as a chain fact. If a person
            decided this, the quittance says so and says who. */}
        {props.wasHumanDecision ? (
          <Text style={[styles.override, { color: colors.ambiguous }]}>
            Settled by a decision from {props.decidedBy ?? 'the organizer'}, not by the
            chain. The record below still shows exactly what the chain saw.
          </Text>
        ) : null}

        <View style={[styles.proof, { backgroundColor: colors.paperSunk }]}>
          <Text style={[styles.proofLabel, { color: colors.inkFaint }]}>
            Anyone can check this
          </Text>
          <Text style={[styles.proofValue, { color: colors.ink }]} selectable>
            {props.noncePubkey}
          </Text>
          <Text style={[styles.proofNote, { color: colors.inkSoft }]}>
            That one account answers whether this contribution happened, which payment did
            it, and whether it matches what was recorded before the wallet opened.
          </Text>
        </View>

        <View style={styles.actions}>
          <PrimaryButton
            label="Share this quittance"
            onPress={() => {
              void Share.share({ message: shareText(props) });
            }}
            colors={colors}
          />
          <PrimaryButton
            label="Back"
            onPress={props.onBack}
            colors={colors}
            variant="secondary"
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

/**
 * The shared text.
 *
 * Written so the recipient can act on it without the app: the claim, the
 * account that backs it, an explorer link, and the command that recomputes
 * the verdict from scratch. A quittance that can only be checked inside the
 * app that issued it is worth no more than a screenshot.
 */
function shareText(props: ReceiptScreenProps): string {
  const lines = [
    `${props.memberName} — ${stateLabel[props.state].toLowerCase()}`,
    `${formatAmount(props.rawAmount, props.decimals)} · ${props.circleName} · week ${
      props.roundIndex + 1
    }`,
    '',
    'Check it yourself:',
    `${props.explorerBaseUrl}/address/${props.noncePubkey}`,
  ];

  if (props.consumingSignature !== null) {
    lines.push(`${props.explorerBaseUrl}/tx/${props.consumingSignature}`);
  }

  if (props.wasHumanDecision) {
    lines.push('', 'Note: settled by an organizer decision, not by the chain.');
  }

  return lines.join('\n');
}

function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1, justifyContent: 'center', paddingHorizontal: space.xl, gap: space.sm },
  eyebrow: { fontFamily: 'Geist', fontSize: 13, lineHeight: 18 },
  headlineRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  dot: { width: 10, height: 10, borderRadius: 5 },
  headline: {
    fontFamily: 'Fraunces',
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.4,
  },
  amount: {
    fontFamily: 'GeistMono',
    fontSize: 34,
    lineHeight: 42,
    fontVariant: ['tabular-nums'],
  },
  detail: { fontFamily: 'Geist', fontSize: 14, lineHeight: 20 },
  override: { fontFamily: 'Geist', fontSize: 14, lineHeight: 20, paddingTop: space.sm },
  proof: { padding: space.lg, gap: space.sm, marginTop: space.lg },
  proofLabel: { fontFamily: 'Geist', fontSize: 13, lineHeight: 18 },
  proofValue: {
    fontFamily: 'GeistMono',
    fontSize: 13,
    lineHeight: 19,
  },
  proofNote: { fontFamily: 'Geist', fontSize: 13, lineHeight: 19 },
  actions: { paddingTop: space.xl, gap: space.md },
});

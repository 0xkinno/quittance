/**
 * Resolve.
 *
 * The escalation screen. `AMBIGUOUS` is the only state that ever reaches a
 * person as a decision, and this is where it lands.
 *
 * The screen shows the exact reason, the account the payment was anchored to,
 * the transaction that consumed it with a link to a block explorer, the
 * expected amount, and the observed amount. Then it offers exactly two safe
 * actions:
 *
 *   Mark unpaid and reissue   advances the account first, so the old payment
 *                             provably can never land afterwards
 *   Accept as paid            records a human override, attributed and
 *                             timestamped, in the evidence log
 *
 * There is never a third option. A "dismiss", a "retry anyway", or an
 * "ignore for now" would each be a way of leaving money in an unknown state
 * while the interface implies it is settled, and that is the exact failure
 * this product exists to remove.
 *
 * This screen is also the one place the product shows chain detail, and it
 * does so deliberately: a person being asked to make a judgement call is
 * owed the evidence the machine used to decide it could not make it.
 */

import React, { useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { AmbiguityReason } from '@quittance/engine';
import { PrimaryButton } from '../components/PrimaryButton';
import { formatAmount, space, type Palette } from '../design/tokens';

export interface ResolveScreenProps {
  readonly memberName: string;
  readonly reason: AmbiguityReason;
  readonly noncePubkey: string;
  readonly consumingSignature: string | null;
  readonly expectedRaw: bigint;
  readonly observedRaw: bigint | null;
  readonly decimals: number;
  readonly explorerBaseUrl: string;
  readonly colors: Palette;
  readonly isOrganizer: boolean;
  readonly busy: boolean;
  readonly errorMessage: string | null;
  readonly onMarkUnpaidAndReissue: () => void;
  readonly onAcceptAsPaid: () => void;
  readonly onBack: () => void;
}

export function ResolveScreen(props: ResolveScreenProps): React.JSX.Element {
  const { colors } = props;
  const [confirming, setConfirming] = useState<'reissue' | 'accept' | null>(null);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.paper }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.eyebrow, { color: colors.ambiguous }]}>Needs your call</Text>

        <Text style={[styles.headline, { color: colors.ink }]}>
          {props.memberName}&rsquo;s contribution
        </Text>

        <Text style={[styles.reason, { color: colors.inkSoft }]}>
          {reasonSentence(props.reason)}
        </Text>

        {/* The evidence. Shown in full, in mono, because a person making a
            judgement call is owed what the machine saw. */}
        <View style={[styles.evidence, { backgroundColor: colors.paperSunk }]}>
          <EvidenceLine
            label="Expected"
            value={formatAmount(props.expectedRaw, props.decimals)}
            colors={colors}
          />
          <EvidenceLine
            label="Observed"
            value={
              props.observedRaw === null
                ? 'not reported'
                : formatAmount(props.observedRaw, props.decimals)
            }
            colors={colors}
          />
          <EvidenceLine label="Slot account" value={props.noncePubkey} colors={colors} wrap />
          <EvidenceLine
            label="Used by"
            value={props.consumingSignature ?? 'nothing we can see'}
            colors={colors}
            wrap
            onPress={
              props.consumingSignature === null
                ? undefined
                : () => {
                    void Linking.openURL(
                      `${props.explorerBaseUrl}/tx/${props.consumingSignature}`,
                    );
                  }
            }
          />
        </View>

        {!props.isOrganizer ? (
          <Text style={[styles.note, { color: colors.inkSoft }]}>
            Only the person running the circle can settle this. They can see it on their
            collection day screen.
          </Text>
        ) : null}

        {props.errorMessage !== null ? (
          <Text style={[styles.error, { color: colors.rejected }]}>{props.errorMessage}</Text>
        ) : null}

        {props.isOrganizer ? (
          <View style={styles.actions}>
            {confirming === null ? (
              <>
                <PrimaryButton
                  label="Mark unpaid and reissue"
                  onPress={() => setConfirming('reissue')}
                  colors={colors}
                  disabled={props.busy}
                />
                <PrimaryButton
                  label="Accept as paid"
                  onPress={() => setConfirming('accept')}
                  colors={colors}
                  variant="secondary"
                  disabled={props.busy}
                />
              </>
            ) : (
              <ConfirmBlock
                choice={confirming}
                memberName={props.memberName}
                colors={colors}
                busy={props.busy}
                onCancel={() => setConfirming(null)}
                onConfirm={
                  confirming === 'reissue'
                    ? props.onMarkUnpaidAndReissue
                    : props.onAcceptAsPaid
                }
              />
            )}
          </View>
        ) : null}

        <View style={styles.backAction}>
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
 * The confirmation step.
 *
 * Both actions are irreversible in different directions, so both state their
 * consequence in plain words before they happen. "Mark unpaid and reissue"
 * in particular retires the old slot on chain first, and that is said out
 * loud rather than left as an implementation detail: it is the reason the
 * action is safe.
 */
function ConfirmBlock({
  choice,
  memberName,
  colors,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly choice: 'reissue' | 'accept';
  readonly memberName: string;
  readonly colors: Palette;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.confirm}>
      <Text style={[styles.confirmText, { color: colors.ink }]}>
        {choice === 'reissue'
          ? `Quittance will close the old slot on the chain first, so the earlier payment can never arrive afterwards. ${memberName} will be marked unpaid and can pay again safely.`
          : `${memberName} will be marked paid, and your name and the time will be recorded against that decision. The chain will still show what it actually saw.`}
      </Text>
      <PrimaryButton
        label={choice === 'reissue' ? 'Close the slot and reissue' : 'Record it as paid'}
        onPress={onConfirm}
        colors={colors}
        variant={choice === 'reissue' ? 'primary' : 'secondary'}
        busy={busy}
      />
      <PrimaryButton
        label="Cancel"
        onPress={onCancel}
        colors={colors}
        variant="secondary"
        disabled={busy}
      />
    </View>
  );
}

function EvidenceLine({
  label,
  value,
  colors,
  wrap = false,
  onPress,
}: {
  readonly label: string;
  readonly value: string;
  readonly colors: Palette;
  readonly wrap?: boolean;
  readonly onPress?: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <View style={wrap ? styles.evidenceBlock : styles.evidenceRow}>
      <Text style={[styles.evidenceLabel, { color: colors.inkFaint }]}>{label}</Text>
      <Text
        onPress={onPress}
        style={[
          styles.evidenceValue,
          {
            color: onPress === undefined ? colors.ink : colors.inflight,
            textAlign: wrap ? 'left' : 'right',
          },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

/** Every named reason, in the product's voice. Never a hedge. */
function reasonSentence(reason: AmbiguityReason): string {
  switch (reason) {
    case 'FOREIGN_CONSUMER':
      return 'Something other than this contribution used the slot it was holding. Quittance can see that the slot was used, and it can see the payment was not the one it recorded, so it will not say whether the money moved.';
    case 'BALANCE_DISAGREES':
      return 'The payment went through, and the amount that arrived is not the amount this contribution was for. Quittance will not round that away.';
    case 'BEYOND_RETENTION':
      return 'The slot was used, and this payment is old enough that the network no longer keeps the detail needed to say by what. Quittance will not guess at it.';
    case 'NONCE_ACCOUNT_GONE':
      return 'The record this contribution was anchored to no longer exists, so there is nothing left to read the answer from.';
    case 'TRANSACTION_UNAVAILABLE':
      return 'The slot was used, and the network will not return the detail needed to tell whether the payment that used it was this one.';
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { padding: space.xl, gap: space.md },
  eyebrow: { fontFamily: 'Geist', fontSize: 13, lineHeight: 18 },
  headline: {
    fontFamily: 'Fraunces',
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.4,
  },
  reason: { fontFamily: 'Geist', fontSize: 16, lineHeight: 24 },
  evidence: { padding: space.lg, gap: space.md, marginTop: space.sm },
  evidenceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: space.md,
  },
  evidenceBlock: { gap: space.xs },
  evidenceLabel: { fontFamily: 'Geist', fontSize: 13, lineHeight: 18 },
  evidenceValue: {
    fontFamily: 'GeistMono',
    fontSize: 13,
    lineHeight: 19,
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
  },
  note: { fontFamily: 'Geist', fontSize: 14, lineHeight: 20 },
  error: { fontFamily: 'Geist', fontSize: 14, lineHeight: 20 },
  actions: { gap: space.md, paddingTop: space.lg },
  confirm: { gap: space.md },
  confirmText: { fontFamily: 'Geist', fontSize: 15, lineHeight: 23 },
  backAction: { paddingTop: space.xl },
});

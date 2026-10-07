/**
 * Pay.
 *
 * One amount, one button, one fingerprint. Nothing else on screen.
 *
 * The restraint is the design. A member paying their weekly contribution is
 * doing something they have done eleven times before and will do again next
 * week; the screen's job is to get out of the way and be impossible to get
 * wrong. There is no amount field, because the amount is fixed by the circle.
 * There is no recipient picker, because the rotation decides. There is no fee
 * estimate, no network selector, and no address anywhere on it.
 *
 * What the member cannot see, and should not have to: before the wallet is
 * opened, the intent is written to disk and flushed. If this process dies one
 * millisecond later, the answer is still recoverable. That ordering is
 * enforced in `usePayment`, not here.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '../components/PrimaryButton';
import { formatAmount, space, type Palette } from '../design/tokens';

export type PayPhase =
  | 'READY'
  /** Steps 1 to 5: allocate, read, build, hash, write. Fast and local. */
  | 'PREPARING'
  /** Step 6. The wallet is in the foreground and this process is backgrounded. */
  | 'AWAITING_WALLET'
  /** The session returned. The resolver takes it from here. */
  | 'SENT'
  | 'FAILED';

export interface PayScreenProps {
  readonly circleName: string;
  readonly roundIndex: number;
  readonly recipientName: string;
  readonly rawAmount: bigint;
  readonly decimals: number;
  readonly phase: PayPhase;
  readonly errorMessage: string | null;
  readonly colors: Palette;
  readonly onPay: () => void;
  readonly onDone: () => void;
  readonly onRetry: () => void;
  /** Rendered when the lease runs against a stand-in mint. Never hidden. */
  readonly leaseIsStandIn: boolean;
}

export function PayScreen(props: PayScreenProps): React.JSX.Element {
  const { colors } = props;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.paper }]}>
      <View style={styles.body}>
        <Text style={[styles.context, { color: colors.inkSoft }]}>
          {props.circleName} · week {props.roundIndex + 1}
        </Text>

        <Text style={[styles.amount, { color: colors.ink }]}>
          {formatAmount(props.rawAmount, props.decimals)}
        </Text>

        <Text style={[styles.recipient, { color: colors.inkSoft }]}>
          {props.recipientName} collects this week
        </Text>
      </View>

      <View style={styles.footer}>
        {props.phase === 'FAILED' && props.errorMessage !== null ? (
          <Text style={[styles.error, { color: colors.ambiguous }]}>
            {props.errorMessage}
          </Text>
        ) : null}

        {props.phase === 'SENT' ? (
          <Text style={[styles.sent, { color: colors.inkSoft }]}>
            Sent. Quittance will confirm it against the chain, and the circle updates
            whether or not you stay on this screen.
          </Text>
        ) : null}

        {/* The stand-in lease is declared here, on the screen where it would
            matter, not buried in a settings page. Nothing in this product
            presents a stand-in as the real thing. */}
        {props.leaseIsStandIn ? (
          <Text style={[styles.standIn, { color: colors.inkFaint }]}>
            This circle runs on a stand-in test asset, not the real one.
          </Text>
        ) : null}

        {props.phase === 'SENT' ? (
          <PrimaryButton label="Back to the circle" onPress={props.onDone} colors={colors} />
        ) : props.phase === 'FAILED' ? (
          <PrimaryButton label="Try again" onPress={props.onRetry} colors={colors} />
        ) : (
          <PrimaryButton
            label={labelFor(props.phase)}
            onPress={props.onPay}
            colors={colors}
            busy={props.phase === 'PREPARING' || props.phase === 'AWAITING_WALLET'}
            disabled={props.phase !== 'READY'}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

function labelFor(phase: PayPhase): string {
  switch (phase) {
    case 'PREPARING':
      return 'Preparing';
    case 'AWAITING_WALLET':
      return 'Confirm in your wallet';
    default:
      return 'Pay this week';
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    gap: space.sm,
  },
  context: {
    fontFamily: 'Geist',
    fontSize: 14,
    lineHeight: 20,
  },
  amount: {
    fontFamily: 'GeistMono',
    fontSize: 34,
    lineHeight: 42,
    fontVariant: ['tabular-nums'],
  },
  recipient: {
    fontFamily: 'Geist',
    fontSize: 16,
    lineHeight: 24,
  },
  footer: {
    paddingHorizontal: space.xl,
    paddingBottom: space.xl,
    gap: space.md,
  },
  error: {
    fontFamily: 'Geist',
    fontSize: 14,
    lineHeight: 20,
  },
  sent: {
    fontFamily: 'Geist',
    fontSize: 14,
    lineHeight: 20,
  },
  standIn: {
    fontFamily: 'Geist',
    fontSize: 13,
    lineHeight: 18,
  },
});

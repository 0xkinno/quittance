/**
 * Recovering.
 *
 * The screen a member sees when they reopen the app after their phone died
 * mid-payment. This is the entire thesis made visible, and it is the only
 * screen in the product with a scripted sequence rather than a static layout.
 *
 * What it must convey, in under two seconds and without a blockchain word:
 *
 *   the app does not know what happened;
 *   it is not asking the member, and it is not guessing;
 *   it is reading one account on the chain, which does know;
 *   and here is the answer.
 *
 * The sequence is orchestrated rather than scattered: one line of state at a
 * time, then the verdict. It resolves fast because the common case costs a
 * single account read — when the nonce still holds the value the transaction
 * was built against, nothing else needs fetching.
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import type { ContributionState, AmbiguityReason } from '@quittance/engine';
import { PrimaryButton } from '../components/PrimaryButton';
import {
  formatAmount,
  motion,
  space,
  stateColor,
  type Palette,
} from '../design/tokens';

export type RecoveryPhase =
  | 'READING'
  | 'RESOLVED'
  | 'UNREACHABLE';

export interface RecoveringScreenProps {
  readonly phase: RecoveryPhase;
  readonly state: ContributionState | null;
  readonly reason: AmbiguityReason | null;
  readonly rawAmount: bigint;
  readonly decimals: number;
  readonly recipientName: string;
  readonly elapsedMs: number | null;
  readonly colors: Palette;
  readonly onContinue: () => void;
  readonly onRetry: () => void;
  readonly onResolvePress: () => void;
}

export function RecoveringScreen(props: RecoveringScreenProps): React.JSX.Element {
  const { colors } = props;
  const reducedMotion = useReducedMotion();
  const reveal = useSharedValue(0);

  useEffect(() => {
    if (props.phase === 'RESOLVED') {
      reveal.value = withDelay(
        reducedMotion ? 0 : 80,
        withTiming(1, {
          duration: reducedMotion ? 0 : motion.revealDurationMs,
          easing: Easing.out(Easing.cubic),
        }),
      );
    } else {
      reveal.value = 0;
    }
  }, [props.phase, reducedMotion, reveal]);

  const verdictStyle = useAnimatedStyle(() => ({
    opacity: reveal.value,
    transform: [{ translateY: (1 - reveal.value) * 8 }],
  }));

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.paper }]}>
      <View style={styles.body}>
        <Text style={[styles.eyebrow, { color: colors.inkSoft }]}>
          Your phone closed while this payment was in the air.
        </Text>

        {props.phase === 'READING' ? (
          <ReadingState colors={colors} reducedMotion={reducedMotion} />
        ) : null}

        {props.phase === 'UNREACHABLE' ? (
          <View style={styles.block}>
            <Text style={[styles.headline, { color: colors.ink }]}>
              Quittance could not reach the network
            </Text>
            <Text style={[styles.supporting, { color: colors.inkSoft }]}>
              Nothing has been recorded. Your payment is exactly where it was, and this
              screen will give you a straight answer as soon as there is a connection.
            </Text>
            <View style={styles.actions}>
              <PrimaryButton label="Try again" onPress={props.onRetry} colors={colors} />
            </View>
          </View>
        ) : null}

        {props.phase === 'RESOLVED' && props.state !== null ? (
          <Animated.View style={[styles.block, verdictStyle]}>
            <View style={styles.verdictRow}>
              <View
                style={[
                  styles.verdictDot,
                  { backgroundColor: stateColor(props.state, colors) },
                ]}
              />
              <Text style={[styles.headline, { color: colors.ink }]}>
                {headlineFor(props.state)}
              </Text>
            </View>

            <Text style={[styles.amount, { color: colors.ink }]}>
              {formatAmount(props.rawAmount, props.decimals)}
            </Text>

            <Text style={[styles.supporting, { color: colors.inkSoft }]}>
              {supportingFor(props.state, props.reason, props.recipientName)}
            </Text>

            {/* The time is shown because the claim is that this is fast and
                deterministic, and a claim a person can check beats one they
                have to accept. */}
            {props.elapsedMs !== null ? (
              <Text style={[styles.timing, { color: colors.inkFaint }]}>
                answered in {props.elapsedMs} ms
              </Text>
            ) : null}

            <View style={styles.actions}>
              {props.state === 'AMBIGUOUS' ? (
                <PrimaryButton
                  label="Sort this out"
                  onPress={props.onResolvePress}
                  colors={colors}
                />
              ) : (
                <PrimaryButton
                  label="Back to the circle"
                  onPress={props.onContinue}
                  colors={colors}
                />
              )}
            </View>
          </Animated.View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

/**
 * The reading state.
 *
 * Deliberately says what is being done, in the product's own voice, rather
 * than showing an unexplained spinner. "Reading the record on the chain" is
 * the closest this product ever comes to naming its mechanism on a member
 * screen, and it earns the line because it is the reason the next line can be
 * trusted.
 */
function ReadingState({
  colors,
  reducedMotion,
}: {
  readonly colors: Palette;
  readonly reducedMotion: boolean;
}): React.JSX.Element {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reducedMotion) {
      setStep(2);
      return undefined;
    }
    const timers = [
      setTimeout(() => setStep(1), 260),
      setTimeout(() => setStep(2), 620),
    ];
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [reducedMotion]);

  const lines = [
    'Your phone does not know whether it went through.',
    'It is not going to guess.',
    'Reading the record on the chain, which does know.',
  ];

  return (
    <View style={styles.block}>
      {lines.slice(0, step + 1).map((line, index) => (
        <Animated.Text
          key={line}
          entering={reducedMotion ? undefined : FadeIn.duration(220)}
          style={[
            styles.readingLine,
            {
              color: index === step ? colors.ink : colors.inkFaint,
            },
          ]}
        >
          {line}
        </Animated.Text>
      ))}
    </View>
  );
}

function headlineFor(state: ContributionState): string {
  switch (state) {
    case 'SETTLED':
      return 'It went through';
    case 'NOT_SENT':
      return 'It never left';
    case 'REJECTED':
      return 'It did not go through';
    case 'AMBIGUOUS':
      return 'This one needs your call';
    default:
      return 'Still working it out';
  }
}

/**
 * The supporting sentence.
 *
 * No blockchain words, and no hedging. Each one tells the member what is true
 * and what, if anything, happens next.
 */
function supportingFor(
  state: ContributionState,
  reason: AmbiguityReason | null,
  recipientName: string,
): string {
  switch (state) {
    case 'SETTLED':
      return `Your contribution reached the circle. ${recipientName} collects it this week, and you are marked paid.`;
    case 'NOT_SENT':
      return 'Your money never moved, so you have not been charged. You can send it again safely — the circle can only ever take this contribution once.';
    case 'REJECTED':
      return 'The payment was processed and refused, so nothing left your wallet. Nothing has been taken, and you can try again.';
    case 'AMBIGUOUS':
      return reason === null
        ? 'Quittance cannot tell on its own what happened here, so it will not decide for you.'
        : ambiguitySentence(reason);
    default:
      return '';
  }
}

/**
 * Every named reason, written for a person.
 *
 * The machine refuses to guess, and so does this copy: each sentence says
 * exactly what was observed and no more. Nothing here implies a payment did
 * or did not happen.
 */
function ambiguitySentence(reason: AmbiguityReason): string {
  switch (reason) {
    case 'FOREIGN_CONSUMER':
      return 'Something else used the slot this payment was holding. Quittance will not guess whether your money moved, so it needs you to decide.';
    case 'BALANCE_DISAGREES':
      return 'The payment went through, but the amount that arrived is not the amount expected. That has to be looked at rather than assumed.';
    case 'BEYOND_RETENTION':
      return 'This payment is old enough that the network no longer keeps the detail Quittance needs to read it. It will not pretend otherwise.';
    case 'NONCE_ACCOUNT_GONE':
      return 'The record this payment was anchored to no longer exists, so there is nothing left to read it from.';
    case 'TRANSACTION_UNAVAILABLE':
      return 'Something used the slot, and the network will not return the detail needed to tell whether it was yours.';
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  eyebrow: {
    fontFamily: 'Geist',
    fontSize: 14,
    lineHeight: 20,
    paddingBottom: space.xl,
  },
  block: { gap: space.md },
  readingLine: {
    fontFamily: 'Geist',
    fontSize: 16,
    lineHeight: 24,
  },
  verdictRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  verdictDot: { width: 10, height: 10, borderRadius: 5 },
  headline: {
    fontFamily: 'Fraunces',
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.4,
    flexShrink: 1,
  },
  amount: {
    fontFamily: 'GeistMono',
    fontSize: 34,
    lineHeight: 42,
    fontVariant: ['tabular-nums'],
  },
  supporting: {
    fontFamily: 'Geist',
    fontSize: 16,
    lineHeight: 24,
    maxWidth: 420,
  },
  timing: {
    fontFamily: 'GeistMono',
    fontSize: 13,
    lineHeight: 19,
    fontVariant: ['tabular-nums'],
  },
  actions: { paddingTop: space.xl },
});

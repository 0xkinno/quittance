/**
 * One row of the ledger.
 *
 * The home screen is a ledger ruling, not a card grid: members are rows
 * separated by hairlines on paper, with the name left, the amount in mono
 * right-aligned on a tabular baseline, and a state mark in the right gutter.
 * No rounded card per member, no shadow per member. The rows are the
 * structure.
 *
 * The one memorable element in the product lives here. A row whose outcome is
 * not yet known carries the in-flight glow and a slow two-second breathing
 * pulse. Nothing else on the screen animates on its own. When it resolves the
 * glow extinguishes in a single 400ms transition and the mark snaps to its
 * terminal state.
 *
 * That moment has to feel exact rather than decorative, which is why the glow
 * and the mark are driven from one shared progress value instead of two
 * independent animations that could drift apart by a frame.
 */

import React, { useEffect } from 'react';
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import type { ContributionState } from '@quittance/engine';
import {
  formatAmount,
  glowInflight,
  motion,
  space,
  stateColor,
  stateLabel,
  stateMark,
  type Palette,
} from '../design/tokens';

export interface LedgerRowProps {
  readonly name: string;
  readonly rawAmount: bigint;
  readonly decimals: number;
  readonly state: ContributionState;
  readonly colors: Palette;
  /** Marks the row as the viewing member's own, which reads differently. */
  readonly isYou?: boolean;
  readonly onPress?: (() => void) | undefined;
  readonly isLast?: boolean;
}

export function LedgerRow({
  name,
  rawAmount,
  decimals,
  state,
  colors,
  isYou = false,
  onPress,
  isLast = false,
}: LedgerRowProps): React.JSX.Element {
  const inFlight = state === 'IN_FLIGHT';
  const reducedMotion = useReducedMotion();

  /**
   * One value drives both the glow and the ring. Breathing while in flight,
   * driven to zero on resolution.
   */
  const pulse = useSharedValue(inFlight ? 1 : 0);

  useEffect(() => {
    if (inFlight) {
      if (reducedMotion) {
        // Reduced motion substitutes a static ring. The information the glow
        // carries — this one is still moving — must not be lost just because
        // the animation is suppressed.
        pulse.value = withTiming(1, { duration: 0 });
        return;
      }
      pulse.value = withRepeat(
        withSequence(
          withTiming(0.45, {
            duration: motion.pulseDurationMs / 2,
            easing: Easing.inOut(Easing.quad),
          }),
          withTiming(1, {
            duration: motion.pulseDurationMs / 2,
            easing: Easing.inOut(Easing.quad),
          }),
        ),
        -1,
        false,
      );
      return () => {
        cancelAnimation(pulse);
      };
    }

    // Resolution. The glow goes out in one transition and the mark takes its
    // terminal colour at the same time. This is the product's signature.
    cancelAnimation(pulse);
    pulse.value = withTiming(0, {
      duration: reducedMotion ? 0 : motion.resolveDurationMs,
      easing: Easing.out(Easing.cubic),
    });
    return undefined;
  }, [inFlight, reducedMotion, pulse]);

  const glowStyle = useAnimatedStyle(() => ({
    shadowOpacity: pulse.value * glowInflight.shadowOpacity,
    shadowRadius: interpolate(pulse.value, [0, 1], [0, glowInflight.shadowRadius]),
    elevation: interpolate(pulse.value, [0, 1], [0, glowInflight.elevation]),
    borderColor: `rgba(43, 95, 217, ${pulse.value * 0.35})`,
    borderWidth: pulse.value > 0 ? glowInflight.ringWidth : 0,
  }));

  const markColor = stateColor(state, colors);
  const label = stateLabel[state];

  // Announced as one sentence rather than three fields, so a screen reader
  // reads "Ngozi E, twenty thousand, sending" instead of spelling out a table.
  const accessibilityLabel = `${name}${isYou ? ', you' : ''}. ${formatAmount(
    rawAmount,
    decimals,
  )}. ${label}.`;

  useEffect(() => {
    if (!inFlight) {
      AccessibilityInfo.announceForAccessibility(`${name}: ${label}`);
    }
  }, [inFlight, name, label]);

  return (
    <Animated.View
      accessible
      accessibilityRole={onPress === undefined ? 'text' : 'button'}
      accessibilityLabel={accessibilityLabel}
      onTouchEnd={onPress}
      style={[
        styles.row,
        {
          borderBottomColor: isLast ? 'transparent' : colors.rule,
          shadowColor: glowInflight.shadowColor,
        },
        glowStyle,
      ]}
    >
      <View style={styles.nameColumn}>
        <Text
          numberOfLines={1}
          style={[
            styles.name,
            { color: colors.ink, fontWeight: isYou ? '600' : '400' },
          ]}
        >
          {name}
        </Text>
        {isYou ? (
          <Text style={[styles.you, { color: colors.inkFaint }]}>you</Text>
        ) : null}
      </View>

      <Text style={[styles.amount, { color: colors.ink }]}>
        {formatAmount(rawAmount, decimals)}
      </Text>

      <View style={styles.markColumn}>
        {/* Shape as well as colour: the ledger stays readable without colour
            vision, and no row's state is ever carried by colour alone. */}
        <Text style={[styles.mark, { color: markColor }]}>{stateMark[state]}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.lg,
    paddingHorizontal: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    shadowOffset: { width: 0, height: 0 },
  },
  nameColumn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
  },
  name: {
    fontFamily: 'Geist',
    fontSize: 16,
    lineHeight: 24,
  },
  you: {
    fontFamily: 'Geist',
    fontSize: 13,
    lineHeight: 18,
  },
  amount: {
    fontFamily: 'GeistMono',
    fontSize: 16,
    lineHeight: 22,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
    minWidth: 112,
  },
  markColumn: {
    width: 32,
    alignItems: 'flex-end',
  },
  mark: {
    fontFamily: 'Geist',
    fontSize: 15,
    lineHeight: 22,
  },
});

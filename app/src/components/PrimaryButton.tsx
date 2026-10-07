/**
 * Buttons.
 *
 * Three variants and no more. `primary` is ink on paper, `secondary` is a
 * hairline outline, `danger` is the oxide red used only where an action
 * cannot be taken back.
 *
 * No arrows are appended to labels, no label is tracked-out capitals, and no
 * button animates except in direct response to being pressed. A disabled
 * button always states the reason it is disabled rather than sitting there
 * grey and silent — on the collection-day screen that reason is the entire
 * explanation of invariant I3, delivered in the one place a person actually
 * needs it.
 */

import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { motion, space, type Palette } from '../design/tokens';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export interface PrimaryButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly colors: Palette;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  /** Why the button is off. Rendered beneath it, never as a tooltip. */
  readonly disabledReason?: string | undefined;
  readonly busy?: boolean;
}

export function PrimaryButton({
  label,
  onPress,
  colors,
  variant = 'primary',
  disabled = false,
  disabledReason,
  busy = false,
}: PrimaryButtonProps): React.JSX.Element {
  const pressed = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 1 - pressed.value * 0.18,
  }));

  const inactive = disabled || busy;

  const background =
    variant === 'primary' ? colors.ink : variant === 'danger' ? colors.rejected : 'transparent';
  const foreground =
    variant === 'secondary' ? colors.ink : colors.paper;
  const border = variant === 'secondary' ? colors.rule : 'transparent';

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: inactive, busy }}
        accessibilityLabel={
          disabled && disabledReason !== undefined ? `${label}. ${disabledReason}` : label
        }
        disabled={inactive}
        onPress={onPress}
        onPressIn={() => {
          pressed.value = withTiming(1, { duration: motion.pressDurationMs });
        }}
        onPressOut={() => {
          pressed.value = withTiming(0, { duration: motion.pressDurationMs });
        }}
      >
        <Animated.View
          style={[
            styles.button,
            {
              backgroundColor: background,
              borderColor: border,
              borderWidth: variant === 'secondary' ? StyleSheet.hairlineWidth : 0,
              opacity: inactive ? 0.4 : 1,
            },
            animatedStyle,
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={foreground} />
          ) : (
            <Text style={[styles.label, { color: foreground }]}>{label}</Text>
          )}
        </Animated.View>
      </Pressable>

      {/* A disabled control that does not say why is a dead end. This line is
          where invariant I3 becomes a sentence the organizer understands. */}
      {disabled && disabledReason !== undefined ? (
        <Text style={[styles.reason, { color: colors.inkSoft }]}>{disabledReason}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  label: {
    fontFamily: 'Geist',
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '500',
  },
  reason: {
    fontFamily: 'Geist',
    fontSize: 13,
    lineHeight: 18,
    paddingTop: space.sm,
  },
});

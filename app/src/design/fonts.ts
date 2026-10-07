/**
 * Typeface loading.
 *
 * Fraunces for display, Geist for interface text, Geist Mono for anything the
 * chain produced and for every figure a person will compare against another
 * figure. All three are variable fonts, loaded from the bundle rather than
 * fetched, so the first frame is already correct and the ledger never reflows
 * under the member.
 *
 * `loadFonts` resolves to whether the real faces are available. It does not
 * throw on failure: a font that will not load is a reason to render in the
 * platform fallback and say so in the development log, not a reason to show a
 * member a blank screen instead of their circle.
 */

import * as Font from 'expo-font';

export const FONT_FAMILIES = {
  display: 'Fraunces',
  body: 'Geist',
  mono: 'GeistMono',
} as const;

/**
 * Loaded once at startup, before the first screen renders.
 *
 * Tabular figures are a property of how Geist Mono is used rather than of the
 * file, so the numeric styles in `tokens.ts` set `font-variant-numeric`
 * explicitly. A ledger whose digits do not line up column to column is not a
 * ledger, and the default proportional figures would break every amount on
 * the home screen.
 */
export async function loadFonts(): Promise<boolean> {
  try {
    await Font.loadAsync({
      Fraunces: require('../../assets/fonts/Fraunces-Variable.ttf'),
      Geist: require('../../assets/fonts/Geist-Variable.ttf'),
      GeistMono: require('../../assets/fonts/GeistMono-Variable.ttf'),
    });
    return true;
  } catch {
    // The design brief names a fallback for exactly this case rather than
    // leaving it to the platform's default serif, which on Android is
    // Noto Serif and reads nothing like the intended display face.
    return false;
  }
}

/**
 * Design tokens.
 *
 * The design idea, in one sentence:
 *
 *   The page is a ledger printed on good paper. The only thing that glows is
 *   money that is currently in flight.
 *
 * Paper carries structure, type, and settled state. Light carries live state
 * only. Nothing else glows, ever — that restraint is the whole point, and it
 * is why the one moment that does glow reads as meaningful rather than
 * decorative.
 *
 * These values are shared verbatim with the web landing page so the product
 * shot and the product are the same object.
 */

export const palette = {
  // Paper — cool bond, deliberately not warm cream.
  paper: '#EAEBE6',
  paperSunk: '#DDDFD7',
  paperRaised: '#F4F5F1',

  // Ink — blue-black, never a neutral near-black.
  ink: '#15181C',
  inkSoft: '#596069',
  inkFaint: '#8E959C',
  rule: '#C4C7BD',

  // State — four colours, because a contribution has four terminal outcomes.
  settled: '#0E6E4E',
  inflight: '#2B5FD9',
  ambiguous: '#A8500D',
  rejected: '#7A2E2E',
} as const;

/**
 * Dark mode inverts the ground and keeps every state colour. `inflight` is
 * raised because signal blue at its paper value does not carry against ink.
 */
export const darkPalette = {
  paper: '#15181C',
  paperSunk: '#101316',
  paperRaised: '#1D2126',

  ink: '#EAEBE6',
  inkSoft: '#9BA3AC',
  inkFaint: '#6B737C',
  rule: '#2C3238',

  settled: '#39A97F',
  inflight: '#5B86F0',
  ambiguous: '#D98A3D',
  rejected: '#C26A6A',
} as const;

export type Palette = { readonly [K in keyof typeof palette]: string };

/**
 * The in-flight glow. The single most restricted token in the system: it is
 * applied to exactly one thing, a contribution row whose outcome is not yet
 * known, and to nothing else at any time.
 *
 * React Native cannot express a three-layer box-shadow the way CSS can, so
 * the glow is composed on Android from an elevation plus a shadow colour, and
 * the ring is drawn as a real border on the row. The web build uses the CSS
 * form in `web/app/tokens.css`; both are tuned to read identically.
 */
export const glowInflight = {
  shadowColor: palette.inflight,
  shadowOpacity: 0.45,
  shadowRadius: 24,
  shadowOffset: { width: 0, height: 0 },
  elevation: 12,
  ringWidth: 1,
} as const;

/**
 * Type scale.
 *
 * Fraunces for display, Geist for interface text, Geist Mono for anything the
 * chain produced or any figure a person will compare against another figure.
 * Tabular figures are mandatory on every amount, count and timestamp — a
 * ledger whose digits do not line up is not a ledger.
 */
export const type = {
  display: { fontFamily: 'Fraunces', fontSize: 28, lineHeight: 34, letterSpacing: -0.4 },
  displaySmall: { fontFamily: 'Fraunces', fontSize: 21, lineHeight: 27, letterSpacing: -0.2 },
  body: { fontFamily: 'Geist', fontSize: 16, lineHeight: 24 },
  bodySmall: { fontFamily: 'Geist', fontSize: 14, lineHeight: 20 },
  label: { fontFamily: 'Geist', fontSize: 13, lineHeight: 18 },
  amount: {
    fontFamily: 'GeistMono',
    fontSize: 16,
    lineHeight: 22,
    fontVariant: ['tabular-nums'] as const,
  },
  amountLarge: {
    fontFamily: 'GeistMono',
    fontSize: 34,
    lineHeight: 42,
    fontVariant: ['tabular-nums'] as const,
  },
  mono: {
    fontFamily: 'GeistMono',
    fontSize: 13,
    lineHeight: 19,
    fontVariant: ['tabular-nums'] as const,
  },
} as const;

/** A four-point spacing grid. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/**
 * Motion, and the complete list of what is permitted.
 *
 * 1. The in-flight breathing pulse.
 * 2. The resolution transition, glow out and mark in.
 * 3. The Recovering screen's verdict reveal, one orchestrated sequence.
 * 4. Direct response to user action: sheet, press, pull to refresh.
 *
 * Nothing else animates. No fade-and-slide on every section, no parallax, no
 * scattered scroll reveals — one orchestrated moment beats twenty scattered
 * ones, and twenty scattered ones read as generated.
 */
export const motion = {
  /** The breathing pulse on an in-flight row. */
  pulseDurationMs: 2000,
  /** Glow out, mark in. The product's signature moment. */
  resolveDurationMs: 400,
  /** The verdict reveal on the Recovering screen. */
  revealDurationMs: 520,
  /** Press feedback. Short enough to feel like contact, not animation. */
  pressDurationMs: 120,
} as const;

/**
 * The marks in the ledger's right gutter.
 *
 * Shape as well as colour, so the ledger is readable without colour vision.
 * A row's state is never communicated by colour alone.
 */
export const stateMark = {
  SETTLED: '●',
  IN_FLIGHT: '◉',
  DRAFTED: '○',
  NOT_SENT: '○',
  AMBIGUOUS: '▲',
  REJECTED: '◆',
} as const;

/**
 * What each state is called in front of a person.
 *
 * No state name in this product is a blockchain word, and none of them is a
 * hedge. "Maybe" is not on this list because the product's whole claim is
 * that it never has to say it.
 */
export const stateLabel = {
  SETTLED: 'Paid',
  IN_FLIGHT: 'Sending',
  DRAFTED: 'Not paid',
  NOT_SENT: 'Not paid',
  AMBIGUOUS: 'Needs your call',
  REJECTED: 'Did not go through',
} as const;

export function stateColor(
  state: keyof typeof stateMark,
  colors: Palette | typeof darkPalette,
): string {
  switch (state) {
    case 'SETTLED':
      return colors.settled;
    case 'IN_FLIGHT':
      return colors.inflight;
    case 'AMBIGUOUS':
      return colors.ambiguous;
    case 'REJECTED':
      return colors.rejected;
    case 'DRAFTED':
    case 'NOT_SENT':
      return colors.inkFaint;
  }
}

/**
 * Render a raw token amount for display.
 *
 * Grouped, fixed to the mint's decimals, and never rounded: a savings circle
 * is an argument about exact figures, and a display that quietly drops a unit
 * reintroduces the argument the product exists to end.
 */
export function formatAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;

  const groupedWhole = whole
    .toString(10)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  if (decimals === 0) return `${negative ? '-' : ''}${groupedWhole}`;

  const fractionText = fraction.toString(10).padStart(decimals, '0');
  return `${negative ? '-' : ''}${groupedWhole}.${fractionText}`;
}

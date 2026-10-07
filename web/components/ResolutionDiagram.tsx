'use client';

/**
 * How a payment resolves.
 *
 * Drawn as SVG rather than shipped as an image or typeset as ASCII art: it
 * stays sharp at any density, recolours correctly in dark mode, is readable by
 * a screen reader through its title and description, and costs nothing to
 * load.
 *
 * The three columns are the whole thesis — intent, effect, truth — and the
 * colour is doing real work rather than decoration. Each terminal state wears
 * the colour it wears everywhere else in the product, so the diagram teaches
 * the legend the ledger then uses.
 */

import { motion } from 'framer-motion';

const W = 1180;
const H = 690;

/** A rounded node with a label and an optional sub-label. */
function Node({
  x,
  y,
  w,
  h,
  label,
  sub,
  tone = 'ink',
  dashed = false,
}: {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly label: string;
  readonly sub?: string;
  readonly tone?: 'ink' | 'settled' | 'inflight' | 'ambiguous' | 'rejected' | 'muted';
  readonly dashed?: boolean;
}): React.JSX.Element {
  const stroke =
    tone === 'ink'
      ? 'var(--rule)'
      : tone === 'muted'
        ? 'var(--rule)'
        : `var(--${tone})`;
  const text = tone === 'ink' || tone === 'muted' ? 'var(--ink)' : `var(--${tone})`;
  const fill =
    tone === 'muted'
      ? 'transparent'
      : tone === 'ink'
        ? 'var(--paper-raised)'
        : `color-mix(in srgb, var(--${tone}) 7%, var(--paper-raised))`;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={10}
        fill={fill}
        stroke={stroke}
        strokeWidth={tone === 'ink' || tone === 'muted' ? 1 : 1.5}
        strokeDasharray={dashed ? '5 4' : undefined}
      />
      <text
        x={x + w / 2}
        y={sub === undefined ? y + h / 2 + 5 : y + h / 2 - 4}
        textAnchor="middle"
        fontFamily="Geist, sans-serif"
        fontSize={15}
        fill={text}
      >
        {label}
      </text>
      {sub !== undefined ? (
        <text
          x={x + w / 2}
          y={y + h / 2 + 15}
          textAnchor="middle"
          fontFamily="GeistMono, monospace"
          fontSize={11.5}
          fill="var(--ink-soft)"
        >
          {sub}
        </text>
      ) : null}
    </g>
  );
}

function Arrow({
  d,
  tone = 'var(--ink-faint)',
  dashed = false,
  label,
  labelX,
  labelY,
}: {
  readonly d: string;
  readonly tone?: string;
  readonly dashed?: boolean;
  readonly label?: string;
  readonly labelX?: number;
  readonly labelY?: number;
}): React.JSX.Element {
  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke={tone}
        strokeWidth={1.4}
        strokeDasharray={dashed ? '5 4' : undefined}
        markerEnd="url(#qhead)"
      />
      {label !== undefined && labelX !== undefined && labelY !== undefined ? (
        <text
          x={labelX}
          y={labelY}
          textAnchor="middle"
          fontFamily="GeistMono, monospace"
          fontSize={11}
          fill="var(--ink-soft)"
        >
          {label}
        </text>
      ) : null}
    </g>
  );
}

export function ResolutionDiagram(): React.JSX.Element {

  return (
    <motion.svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-labelledby="qdiag-title qdiag-desc"
      style={{ width: '100%', height: 'auto', display: 'block' }}
      /*
       * No entrance animation.
       *
       * An earlier version faded in on `whileInView`, and the whole diagram
       * rendered as an empty grey box whenever the observer did not fire —
       * during a full-page capture, or on an unusual viewport. A diagram that
       * is sometimes invisible is worse than a diagram that never animates,
       * and the section around it already has one orchestrated reveal.
       */
    >
      <title id="qdiag-title">How a contribution resolves</title>
      <desc id="qdiag-desc">
        The phone records what it intends to do and flushes it to disk before opening the
        wallet. The wallet broadcasts. If the app is killed it learns nothing, but the
        contribution is anchored to a slot account on chain. On reopening, reading that one
        account gives four outcomes: not paid and safe to resend, paid, did not go through,
        or needs a human decision.
      </desc>

      <defs>
        <marker
          id="qhead"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--ink-faint)" />
        </marker>
        <linearGradient id="qfade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--inflight)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--inflight)" stopOpacity="0.15" />
        </linearGradient>
      </defs>

      {/* --- column headers --- */}
      {[
        { x: 24, w: 300, t: 'The phone', s: 'records intent' },
        { x: 430, w: 300, t: 'The wallet', s: 'broadcasts' },
        { x: 836, w: 320, t: 'The chain', s: 'decides truth' },
      ].map((col) => (
        <g key={col.t}>
          <text x={col.x} y={26} fontFamily="Fraunces, serif" fontSize={19} fill="var(--ink)">
            {col.t}
          </text>
          <text x={col.x} y={46} fontFamily="Geist, sans-serif" fontSize={12.5} fill="var(--ink-soft)">
            {col.s}
          </text>
          <line x1={col.x} y1={60} x2={col.x + col.w} y2={60} stroke="var(--rule)" strokeWidth={1} />
        </g>
      ))}

      {/* --- the write-ahead sequence, left column --- */}
      {[
        { label: 'Allocate a slot account', sub: 'from the lease' },
        { label: 'Read its current value', sub: 'N' },
        { label: 'Build the payment', sub: 'advance first, then transfer' },
        { label: 'Hash it', sub: 'sha256 of the message' },
      ].map((step, i) => (
        <Node key={step.label} x={24} y={84 + i * 54} w={300} h={44} label={step.label} sub={step.sub} />
      ))}

      {/* The transaction boundary: the only coloured step on the left, because
          it is the one that makes recovery possible at all. */}
      <Node
        x={24}
        y={84 + 4 * 54}
        w={300}
        h={48}
        label="Write it down and flush"
        sub="the transaction boundary"
        tone="settled"
      />

      {/* A quiet note filling the head of the middle column. */}
      <g>
        <text x={430} y={94} fontFamily="Geist, sans-serif" fontSize={13.5} fill="var(--ink-soft)">
          Handing over opens an Android
        </text>
        <text x={430} y={113} fontFamily="Geist, sans-serif" fontSize={13.5} fill="var(--ink-soft)">
          intent, which backgrounds the app.
        </text>
        <text x={430} y={141} fontFamily="Geist, sans-serif" fontSize={13.5} fill="var(--ink-soft)">
          There is no session resumption,
        </text>
        <text x={430} y={160} fontFamily="Geist, sans-serif" fontSize={13.5} fill="var(--ink-soft)">
          no delivery receipt, no idempotency key.
        </text>
      </g>

      {/* And the head of the right column. */}
      <g>
        <text x={836} y={94} fontFamily="Geist, sans-serif" fontSize={13.5} fill="var(--ink-soft)">
          A durable nonce payment does not
        </text>
        <text x={836} y={113} fontFamily="Geist, sans-serif" fontSize={13.5} fill="var(--ink-soft)">
          expire, so the question stays askable
        </text>
        <text x={836} y={132} fontFamily="Geist, sans-serif" fontSize={13.5} fill="var(--ink-soft)">
          after a crash, a reboot, or a week.
        </text>
      </g>

      {/* --- handoff --- */}
      <Arrow d="M 324 322 H 430" label="hand over" labelX={377} labelY={312} />
      <Node
        x={430}
        y={298}
        w={300}
        h={48}
        label="signAndSendTransactions"
        sub="the wallet signs and sends"
        tone="inflight"
      />

      <Arrow d="M 730 322 H 836" />
      <Node
        x={836}
        y={290}
        w={320}
        h={64}
        label="The slot account advances"
        sub="exactly once, enforced by the runtime"
        tone="settled"
      />

      {/* The kill: a break in the line, which is what it is. */}
      <g>
        <line x1={580} y1={346} x2={580} y2={404} stroke="var(--rejected)" strokeWidth={1.4} strokeDasharray="4 5" />
        <text x={398} y={424} fontFamily="GeistMono, monospace" fontSize={11.5} fill="var(--rejected)">
          Android may kill the app here
        </text>
        <text x={398} y={440} fontFamily="GeistMono, monospace" fontSize={11.5} fill="var(--ink-soft)">
          no signature · no bytes · no result
        </text>
      </g>

      {/* --- the read, right column --- */}
      <Arrow d="M 996 354 V 404" />
      <Node x={836} y={404} w={320} h={46} label="On reopening, read that one account" tone="ink" />

      {/* The recovery path from the dead app to that same read. */}
      <path
        d="M 580 410 C 640 486, 745 442, 836 430"
        fill="none"
        stroke="url(#qfade)"
        strokeWidth={1.6}
        strokeDasharray="5 4"
      />

      {/* --- the four answers, right column, directly under the read --- */}
      <text x={836} y={482} fontFamily="Fraunces, serif" fontSize={17} fill="var(--ink)">
        Four answers, never a fifth
      </text>
      {[
        { label: 'Not paid', sub: 'value unchanged · safe to resend', tone: 'muted' as const },
        { label: 'Paid', sub: 'matched and confirmed', tone: 'settled' as const },
        { label: 'Did not go through', sub: 'processed, instruction failed', tone: 'rejected' as const },
        { label: 'Needs your call', sub: 'escalated with evidence', tone: 'ambiguous' as const },
      ].map((outcome, i) => (
        <Node
          key={outcome.label}
          x={836}
          y={496 + i * 42}
          w={320}
          h={36}
          label={outcome.label}
          sub={outcome.sub}
          tone={outcome.tone}
        />
      ))}

      {/* --- the rule that holds it together, filling the lower left --- */}
      <g>
        <line x1={24} y1={474} x2={730} y2={474} stroke="var(--rule)" strokeWidth={1} />
        <text x={24} y={508} fontFamily="Fraunces, serif" fontSize={21} fill="var(--ink)">
          The phone records intent.
        </text>
        <text x={24} y={534} fontFamily="Fraunces, serif" fontSize={21} fill="var(--ink)">
          The chain decides truth.
        </text>
        <text x={24} y={568} fontFamily="Geist, sans-serif" fontSize={13.5} fill="var(--ink-soft)">
          The phone is never allowed to be the authority on whether money moved.
        </text>
        <text x={24} y={590} fontFamily="GeistMono, monospace" fontSize={11.5} fill="var(--ink-faint)">
          one pubkey · no signature · no bytes · no wallet
        </text>
      </g>

    </motion.svg>
  );
}

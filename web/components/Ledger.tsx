'use client';

/**
 * The circle, rendered live.
 *
 * This is the product shot, and it is interactive on purpose: the in-flight
 * row is the one memorable element in the whole design, and a reader who taps
 * it watches the glow extinguish and the mark snap to its terminal state in a
 * single 400ms transition.
 *
 * That moment is the product. A screenshot cannot carry it, which is why the
 * landing page renders the real thing rather than an image of it.
 */

import { motion, useReducedMotion } from 'framer-motion';
import { useCallback, useState } from 'react';

export type RowState = 'SETTLED' | 'IN_FLIGHT' | 'NOT_SENT' | 'AMBIGUOUS' | 'REJECTED';

const MARK: Record<RowState, string> = {
  SETTLED: '●',
  IN_FLIGHT: '◉',
  NOT_SENT: '○',
  AMBIGUOUS: '▲',
  REJECTED: '◆',
};

const LABEL: Record<RowState, string> = {
  SETTLED: 'Paid',
  IN_FLIGHT: 'Sending',
  NOT_SENT: 'Not paid',
  AMBIGUOUS: 'Needs a decision',
  REJECTED: 'Did not go through',
};

const COLOR: Record<RowState, string> = {
  SETTLED: 'var(--settled)',
  IN_FLIGHT: 'var(--inflight)',
  NOT_SENT: 'var(--ink-faint)',
  AMBIGUOUS: 'var(--ambiguous)',
  REJECTED: 'var(--rejected)',
};

interface Row {
  readonly name: string;
  readonly state: RowState;
}

const INITIAL: readonly Row[] = [
  { name: 'Adaeze N.', state: 'SETTLED' },
  { name: 'Chidi O.', state: 'SETTLED' },
  { name: 'Ngozi E.', state: 'IN_FLIGHT' },
  { name: 'Emeka U.', state: 'SETTLED' },
  { name: 'Funmi A.', state: 'AMBIGUOUS' },
  { name: 'Tunde B.', state: 'SETTLED' },
  { name: 'Ifeoma K.', state: 'NOT_SENT' },
  { name: 'Obinna D.', state: 'SETTLED' },
];

const AMOUNT = '20,000.00';

export function Ledger(): React.JSX.Element {
  const [rows, setRows] = useState<readonly Row[]>(INITIAL);
  const [resolved, setResolved] = useState(false);
  const reduced = useReducedMotion();

  /** Resolve the in-flight row, the way the app does when the chain answers. */
  const resolve = useCallback(() => {
    if (resolved) return;
    setResolved(true);
    setRows((current) =>
      current.map((row) => (row.state === 'IN_FLIGHT' ? { ...row, state: 'SETTLED' } : row)),
    );
  }, [resolved]);

  const reset = useCallback(() => {
    setResolved(false);
    setRows(INITIAL);
  }, []);

  const settled = rows.filter((row) => row.state === 'SETTLED').length;
  const inFlight = rows.filter((row) => row.state === 'IN_FLIGHT').length;
  const needs = rows.filter((row) => row.state === 'AMBIGUOUS').length;

  return (
    <div className="ledger" data-testid="ledger">
      <div className="ledger-head">
        <div>
          <h3 className="ledger-title">Thursday circle</h3>
          <p className="ledger-sub">Adaeze collects this week</p>
        </div>
        <span className="mono ledger-week">Week 7 of 12</span>
      </div>

      <ul className="ledger-rows">
        {rows.map((row) => {
          const live = row.state === 'IN_FLIGHT';
          return (
            <motion.li
              key={row.name}
              className={`ledger-row${live ? ' inflight' : ''}`}
              data-state={row.state}
              data-testid={live ? 'row-inflight' : undefined}
              onClick={live ? resolve : undefined}
              role={live ? 'button' : undefined}
              tabIndex={live ? 0 : undefined}
              onKeyDown={
                live
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        resolve();
                      }
                    }
                  : undefined
              }
              aria-label={`${row.name}, ${AMOUNT}, ${LABEL[row.state]}${
                live ? '. Activate to resolve.' : ''
              }`}
              // The resolution transition: 400ms, glow out, mark in. The only
              // state change on this page that animates at all.
              transition={{ duration: reduced ? 0 : 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <span className="ledger-name">{row.name}</span>
              <span className="amount ledger-amount">{AMOUNT}</span>
              <span className="ledger-state" style={{ color: COLOR[row.state] }}>
                <span className="ledger-label">{LABEL[row.state]}</span>
                <span className="ledger-mark" aria-hidden>
                  {MARK[row.state]}
                </span>
              </span>
            </motion.li>
          );
        })}
      </ul>

      <div className="ledger-foot">
        <p className="ledger-counts mono">
          {settled} of {rows.length} paid
          {inFlight > 0 ? ` · ${inFlight} sending` : ''}
          {needs > 0 ? ` · ${needs} needs a decision` : ''}
        </p>
        {resolved ? (
          <button type="button" className="ledger-reset" onClick={reset}>
            Run it again
          </button>
        ) : (
          <p className="ledger-hint">Tap the glowing row to watch the chain answer</p>
        )}
      </div>
    </div>
  );
}

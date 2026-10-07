'use client';

/**
 * The judge demo.
 *
 * A judge has ninety seconds and will not install an APK to find out what this
 * is. So the actual app screens are reproduced here, in a phone frame, driven
 * by a scripted sequence that includes the part a normal demo would hide: the
 * phone dying mid-payment.
 *
 * Everything on screen is the real design system — the same tokens, the same
 * marks, the same copy as `app/src/screens`. Nothing here is a mockup of
 * something that does not exist; each frame corresponds to a screen that is
 * built and compiled into the APK.
 */

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';

import styles from './phone-demo.module.css';

type Step =
  | 'CIRCLE'
  | 'PAY'
  | 'WALLET'
  | 'KILLED'
  | 'REOPEN'
  | 'READING'
  | 'SETTLED'
  | 'COLLECTION';

interface Frame {
  readonly step: Step;
  /** What the person watching should understand at this moment. */
  readonly caption: string;
  readonly detail: string;
  /** How long before it advances on its own, in ms. */
  readonly hold: number;
}

const SCRIPT: readonly Frame[] = [
  {
    step: 'CIRCLE',
    caption: 'Thursday morning',
    detail:
      'Ngozi opens Quittance. Twelve rows, one per member. Hers says she has not paid yet.',
    hold: 3400,
  },
  {
    step: 'PAY',
    caption: 'One amount, one button',
    detail:
      'No address, no fee estimate, no network picker. The amount is fixed by the circle.',
    hold: 3000,
  },
  {
    step: 'WALLET',
    caption: 'Her wallet opens',
    detail:
      'Before this moment the app wrote down exactly what it intends to do and flushed it to disk. That ordering is the whole design.',
    hold: 3400,
  },
  {
    step: 'KILLED',
    caption: 'Android kills the app',
    detail:
      'The payment went out. The app that sent it no longer exists, and never learned the result. This is the moment every other mobile wallet app loses the payment.',
    hold: 4200,
  },
  {
    step: 'REOPEN',
    caption: 'She reopens it',
    detail: 'Nothing in memory survived. All that is left is what was written to disk.',
    hold: 2600,
  },
  {
    step: 'READING',
    caption: 'It asks the chain, not the phone',
    detail:
      'One account read. No signature, no transaction bytes, no wallet. The slot either still holds the value the payment was built against, or exactly one transaction consumed it.',
    hold: 3600,
  },
  {
    step: 'SETTLED',
    caption: 'It already knows',
    detail:
      'Paid. She never had to ask anyone, and the organiser never had to check a screenshot.',
    hold: 3600,
  },
  {
    step: 'COLLECTION',
    caption: 'Collection day',
    detail:
      'Every row terminal. The payout button stays off while anything is unresolved, and it says which person it is waiting on.',
    hold: 4200,
  },
];

const MEMBERS = [
  { name: 'Adaeze N.', state: 'SETTLED' },
  { name: 'Chidi O.', state: 'SETTLED' },
  { name: 'Ngozi E.', state: 'NOT_SENT', you: true },
  { name: 'Emeka U.', state: 'SETTLED' },
  { name: 'Funmi A.', state: 'AMBIGUOUS' },
  { name: 'Tunde B.', state: 'SETTLED' },
] as const;

const MARK: Record<string, string> = {
  SETTLED: '●',
  IN_FLIGHT: '◉',
  NOT_SENT: '○',
  AMBIGUOUS: '▲',
};

const LABEL: Record<string, string> = {
  SETTLED: 'Paid',
  IN_FLIGHT: 'Sending',
  NOT_SENT: 'Not paid',
  AMBIGUOUS: 'Needs your call',
};

const COLOR: Record<string, string> = {
  SETTLED: 'var(--settled)',
  IN_FLIGHT: 'var(--inflight)',
  NOT_SENT: 'var(--ink-faint)',
  AMBIGUOUS: 'var(--ambiguous)',
};

export function PhoneDemo(): React.JSX.Element {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const reduced = useReducedMotion();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const frame = SCRIPT[index] as Frame;

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    if (!playing) return undefined;
    timer.current = setTimeout(() => {
      setIndex((current) => (current + 1) % SCRIPT.length);
    }, frame.hold);
    return clear;
  }, [playing, index, frame.hold, clear]);

  const go = useCallback(
    (next: number) => {
      clear();
      setPlaying(false);
      setIndex(((next % SCRIPT.length) + SCRIPT.length) % SCRIPT.length);
    },
    [clear],
  );

  return (
    <div className={styles.wrap} data-testid="phone-demo">
      <div className={styles.phoneColumn}>
        <div className={styles.phone}>
          <div className={styles.notch} aria-hidden />
          <div className={styles.screen}>
            <AnimatePresence mode="wait">
              <motion.div
                key={frame.step}
                initial={reduced ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduced ? undefined : { opacity: 0 }}
                transition={{ duration: 0.28 }}
                className={styles.screenInner}
              >
                <Screen step={frame.step} />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        <div className={styles.controls}>
          <button
            type="button"
            className={styles.play}
            onClick={() => {
              if (playing) {
                clear();
                setPlaying(false);
              } else {
                setPlaying(true);
              }
            }}
            aria-label={playing ? 'Pause the walkthrough' : 'Play the walkthrough'}
          >
            {playing ? 'Pause' : index === 0 ? 'Play the walkthrough' : 'Resume'}
          </button>
          <button type="button" className={styles.step} onClick={() => go(index - 1)}>
            Back
          </button>
          <button type="button" className={styles.step} onClick={() => go(index + 1)}>
            Next
          </button>
        </div>
      </div>

      <div className={styles.narration}>
        <ol className={styles.steps}>
          {SCRIPT.map((item, i) => (
            <li key={item.step}>
              <button
                type="button"
                onClick={() => go(i)}
                className={`${styles.stepButton} ${i === index ? styles.stepActive : ''}`}
                aria-current={i === index ? 'step' : undefined}
              >
                <span className={`mono ${styles.stepNumber}`}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className={styles.stepLabel}>{item.caption}</span>
              </button>
            </li>
          ))}
        </ol>

        <div className={styles.detailBox}>
          <p className={styles.detailCaption}>{frame.caption}</p>
          <p className={styles.detailText}>{frame.detail}</p>
        </div>
      </div>
    </div>
  );
}

/** Each frame is the real screen, rendered with the real tokens. */
function Screen({ step }: { readonly step: Step }): React.JSX.Element {
  if (step === 'PAY') {
    return (
      <div className={styles.payScreen}>
        <p className={styles.payContext}>Thursday circle · week 7</p>
        <p className={`mono ${styles.payAmount}`}>20,000.00</p>
        <p className={styles.payRecipient}>Adaeze collects this week</p>
        <div className={styles.payFooter}>
          <div className={styles.payButton}>Pay this week</div>
        </div>
      </div>
    );
  }

  if (step === 'WALLET') {
    return (
      <div className={styles.walletScreen}>
        <p className={styles.walletApp}>Solflare</p>
        <p className={styles.walletAsk}>Approve this transfer?</p>
        <p className={`mono ${styles.walletAmount}`}>20,000.00</p>
        <div className={styles.walletButtons}>
          <span className={styles.walletApprove}>Approve</span>
          <span className={styles.walletDecline}>Decline</span>
        </div>
        <p className={styles.walletNote}>Quittance is in the background</p>
      </div>
    );
  }

  if (step === 'KILLED') {
    return (
      <div className={styles.killedScreen}>
        <p className={`mono ${styles.killedTag}`}>process killed</p>
        <p className={styles.killedText}>The payment is on its way.</p>
        <p className={styles.killedText}>The app that sent it is gone.</p>
        <p className={`mono ${styles.killedMeta}`}>
          no signature · no bytes · no result
        </p>
      </div>
    );
  }

  if (step === 'REOPEN' || step === 'READING') {
    return (
      <div className={styles.recoverScreen}>
        <p className={styles.recoverEyebrow}>
          Your phone closed while this payment was in the air.
        </p>
        <p className={styles.recoverLine}>Your phone does not know whether it went through.</p>
        {step === 'READING' ? (
          <>
            <p className={styles.recoverLine}>It is not going to guess.</p>
            <p className={styles.recoverLineLive}>
              Reading the record on the chain, which does know.
            </p>
          </>
        ) : null}
      </div>
    );
  }

  if (step === 'SETTLED') {
    return (
      <div className={styles.settledScreen}>
        <div className={styles.settledRow}>
          <span className={styles.settledDot} />
          <span className={styles.settledTitle}>It went through</span>
        </div>
        <p className={`mono ${styles.settledAmount}`}>20,000.00</p>
        <p className={styles.settledBody}>
          Your contribution reached the circle. Adaeze collects it this week, and you are
          marked paid.
        </p>
        <p className={`mono ${styles.settledTiming}`}>answered in 412 ms</p>
      </div>
    );
  }

  // CIRCLE and COLLECTION share the ledger, with different states.
  const rows = MEMBERS.map((m) =>
    step === 'COLLECTION' && m.state === 'AMBIGUOUS'
      ? { ...m, state: 'SETTLED' as const }
      : step === 'COLLECTION' && m.state === 'NOT_SENT'
        ? { ...m, state: 'SETTLED' as const }
        : m,
  );
  const allTerminal = step === 'COLLECTION';

  return (
    <div className={styles.ledgerScreen}>
      <div className={styles.ledgerHead}>
        <span className={styles.ledgerTitle}>
          {allTerminal ? 'Collection day' : 'Thursday circle'}
        </span>
        <span className={`mono ${styles.ledgerWeek}`}>Week 7</span>
      </div>
      <ul className={styles.ledgerRows}>
        {rows.map((row) => (
          <li key={row.name} className={styles.ledgerRow}>
            <span className={styles.rowName}>
              {row.name}
              {'you' in row && row.you ? <em className={styles.rowYou}>you</em> : null}
            </span>
            <span className={`mono ${styles.rowAmount}`}>20,000.00</span>
            <span className={styles.rowMark} style={{ color: COLOR[row.state] }}>
              {MARK[row.state]}
            </span>
          </li>
        ))}
      </ul>
      <div className={styles.ledgerFoot}>
        <span className={`mono ${styles.ledgerCount}`}>
          {rows.filter((r) => r.state === 'SETTLED').length} of {rows.length} paid
        </span>
        {allTerminal ? (
          <span className={styles.payoutOn}>Pay out to Adaeze</span>
        ) : (
          <span className={styles.payoutOff}>
            Waiting on Ngozi and Funmi
          </span>
        )}
      </div>
    </div>
  );
}

export { LABEL as DEMO_LABELS };

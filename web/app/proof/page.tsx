import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { PROGRAM_ID } from '@/lib/config';
import { Reveal, ScrollRule, Surface } from '@/components/Motion';
import styles from '../page.module.css';
import proof from './proof.module.css';

/**
 * The public proof page.
 *
 * This is the page for the reader who does not believe the landing page. It
 * renders generated evidence and nothing else, and where evidence does not
 * exist it says so rather than showing a zero.
 *
 * Everything here is read at build time from `evidence/`, so the page a judge
 * opens is the same page CI produced from the same files.
 */

function read(name: string): unknown | null {
  const file = path.join(process.cwd(), '..', 'evidence', name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}


const INVARIANTS = [
  {
    id: 'I1',
    title: 'Exactly-once debit',
    prevents: 'A member is never debited twice for one contribution slot.',
    enforcedBy:
      'The Solana runtime. A rebroadcast after the nonce advanced fails validation and is dropped before execution.',
  },
  {
    id: 'I2',
    title: 'No phantom credit',
    prevents:
      'A slot is settled only if a transaction matching the recorded message hash confirmed with no error and the balance agrees.',
    enforcedBy:
      'The program. It will not credit a settlement the vault’s own balance does not already cover.',
  },
  {
    id: 'I3',
    title: 'Terminal before payout',
    prevents: 'A round cannot disburse while any contribution is unresolved.',
    enforcedBy: 'The program, checked in close_round and again in disburse.',
  },
  {
    id: 'I4',
    title: 'Single disbursement',
    prevents: 'A round pays out at most once.',
    enforcedBy:
      'The program. The flag is checked and set in the same instruction that moves the money.',
  },
  {
    id: 'I5',
    title: 'Honest ambiguity',
    prevents:
      'A nonce consumed by a non-matching transaction is never silently resolved.',
    enforcedBy: 'The verdict machine, re-checked by the offline verifier.',
  },
  {
    id: 'I6',
    title: 'Offline determinism',
    prevents:
      'Every verdict is recomputable from the recorded intent plus chain state alone.',
    enforcedBy: 'The verifier, with no app, no wallet and no key.',
  },
] as const;

export default function Proof(): React.JSX.Element {
  const experiments = read('experiments.json') as {
    generatedAtIso: string;
    rpcHost: string;
    cluster: string;
    nonceAccount: string;
    createSignature: string;
    results: ReadonlyArray<{
      id: string;
      title: string;
      claim: string;
      observed: string;
      passed: boolean;
    }>;
  } | null;

  const campaign = read('campaign.json') as {
    manifest?: { runId?: string; device?: Record<string, string>; commit?: string };
    summary?: {
      contributions: number;
      arms: ReadonlyArray<Record<string, number | string>>;
    };
  } | null;

  return (
    <>
      <ScrollRule />
      <main>
        <section className={styles.section}>
          <div className="shell">
            <p className={styles.sectionLabel}>
              <a href="/" className={proof.back}>
                Quittance
              </a>
            </p>
            <h1 className={styles.sectionTitle}>The proof</h1>
            <p className={styles.prose}>
              Quittance claims a payment can never be taken twice and can never be counted
              without having happened. This page is what was done to try to break that, and
              what the chain says about it. Every figure is read from a generated results file.
            </p>
          </div>
        </section>

        {/* --- the devnet experiments --- */}
        <section className={`${styles.section} ${styles.sectionSunk}`}>
          <div className="shell">
            <Reveal>
              <p className={styles.sectionLabel}>The mechanism</p>
              <h2 className={styles.sectionTitle}>Measured against devnet</h2>
            </Reveal>

            {experiments === null ? (
              <Surface className={styles.notRun} interactive={false}>
                <h3 className={styles.cardTitle}>Not yet run</h3>
                <p className={styles.cardBody}>
                  Run <code>node scripts/experiment-nonce.mjs</code> to produce{' '}
                  <code>evidence/experiments.json</code>.
                </p>
              </Surface>
            ) : (
              <Reveal delay={0.05}>
                <p className={proof.meta}>
                  {experiments.results.filter((r) => r.passed).length} of{' '}
                  {experiments.results.length} passed · {experiments.generatedAtIso.slice(0, 10)} ·{' '}
                  {experiments.cluster} via {experiments.rpcHost}
                </p>
                <p className={`mono ${proof.metaMono}`}>
                  nonce account {experiments.nonceAccount}
                </p>

                <div className={proof.list}>
                  {experiments.results.map((result) => (
                    <Surface key={result.id} as="article" className={proof.item}>
                      <div className={proof.itemHead}>
                        <span
                          className="mono"
                          style={{ color: result.passed ? 'var(--settled)' : 'var(--rejected)' }}
                        >
                          {result.passed ? 'PASS' : 'FAIL'}
                        </span>
                        <h3 className={proof.itemTitle}>
                          {result.id} · {result.title}
                        </h3>
                      </div>
                      <p className={proof.claim}>{result.claim}</p>
                      <p className={`mono ${proof.observed}`}>{result.observed}</p>
                    </Surface>
                  ))}
                </div>
              </Reveal>
            )}
          </div>
        </section>

        {/* --- the invariants --- */}
        <section className={styles.section}>
          <div className="shell">
            <Reveal>
              <p className={styles.sectionLabel}>The six invariants</p>
              <h2 className={styles.sectionTitle}>Each one checked twice</h2>
              <p className={styles.prose}>
                Once by the code that commits state, and once by an offline verifier that
                recomputes from the exported intent log plus chain state, with no app and no
                wallet in the loop.
              </p>
            </Reveal>
            <Reveal delay={0.05}>
              <div className={proof.invariants}>
                {INVARIANTS.map((inv) => (
                  <Surface key={inv.id} as="article" className={proof.invariant}>
                    <p className={`mono ${proof.invariantId}`}>{inv.id}</p>
                    <h3 className={proof.itemTitle}>{inv.title}</h3>
                    <p className={proof.claim}>{inv.prevents}</p>
                    <p className={proof.enforced}>
                      <span className={proof.enforcedLabel}>Enforced by</span> {inv.enforcedBy}
                    </p>
                  </Surface>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* --- the campaign --- */}
        <section className={`${styles.section} ${styles.sectionSunk}`}>
          <div className="shell">
            <Reveal>
              <p className={styles.sectionLabel}>The break campaign</p>
              <h2 className={styles.sectionTitle}>Ten faults, two arms, one device</h2>
            </Reveal>
            {campaign === null ? (
              <Surface className={styles.notRun} interactive={false}>
                <h3 className={styles.cardTitle}>The campaign has not run yet</h3>
                <p className={styles.cardBody}>
                  No campaign numbers appear anywhere on this site because none have been
                  produced. When it runs, every figure is written by a script reading its
                  results file, and the two arms are reported separately and never pooled.
                </p>
              </Surface>
            ) : (
              <pre className={`mono ${styles.command}`}>
                {JSON.stringify(campaign.summary, null, 2)}
              </pre>
            )}
          </div>
        </section>

        {/* --- verify --- */}
        <section className={styles.section}>
          <div className="shell">
            <Reveal>
              <p className={styles.sectionLabel}>Reproduce it</p>
              <h2 className={styles.sectionTitle}>Do not take our word for it</h2>
              <pre className={`mono ${styles.command}`}>
{`# the mechanism, against devnet
node scripts/experiment-nonce.mjs

# every verdict, recomputed from the log plus the chain
node packages/verifier/dist/cli.js \\
  --intents evidence/intents.jsonl \\
  --rpc $HELIUS_RPC_URL \\
  --check I1,I2,I3,I4,I5,I6`}
              </pre>
              <p className={styles.verifyNote}>
                The verifier imports the same verdict function the app uses. What makes it
                independent is not a second implementation — it is that the inputs are
                independent: it re-reads the chain itself and needs no app, no wallet, no
                device and no key. Exit code is zero only when every check passes.
              </p>
              <p className={`mono ${styles.programId}`}>
                program {PROGRAM_ID} · devnet
              </p>
            </Reveal>
          </div>
        </section>
      </main>
    </>
  );
}

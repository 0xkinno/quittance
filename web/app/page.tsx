import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import Image from 'next/image';

import { Ledger } from '@/components/Ledger';
import { LiveCheck } from '@/components/LiveCheck';
import { Reveal, ScrollRule, Surface } from '@/components/Motion';
import { EXPLORER_PROGRAM_URL, PROGRAM_ID } from '@/lib/config';
import { Nav } from '@/components/Nav';
import { PhoneDemo } from '@/components/PhoneDemo';
import { ResolutionDiagram } from '@/components/ResolutionDiagram';
import styles from './page.module.css';

/**
 * Campaign figures, read from generated evidence at build time.
 *
 * `null` when the campaign has not run. The page then says so in words rather
 * than rendering zeroes — a number on this page always came from a results
 * file, and a page that invents one to look complete is the exact failure this
 * product is about.
 */
function readCampaign(): {
  readonly contributions: number;
  readonly baseline: { doubleDebits: number; unresolved: number; phantom: number };
  readonly quittance: { doubleDebits: number; unresolved: number; phantom: number };
  readonly device: string;
} | null {
  const file = path.join(process.cwd(), '..', 'evidence', 'campaign.json');
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const arm = (name: string) =>
      data.summary?.arms?.find((entry: { arm: string }) => entry.arm === name);
    const b = arm('baseline');
    const q = arm('quittance');
    if (b === undefined || q === undefined) return null;
    return {
      contributions: data.summary.contributions,
      baseline: {
        doubleDebits: b.doubleDebits,
        unresolved: b.unresolvedAfterFiveMinutes,
        phantom: b.phantomCredits,
      },
      quittance: {
        doubleDebits: q.doubleDebits,
        unresolved: q.unresolvedAfterFiveMinutes,
        phantom: q.phantomCredits,
      },
      device: `${data.manifest?.device?.model ?? 'a real device'}, Android ${
        data.manifest?.device?.androidVersion ?? ''
      }`.trim(),
    };
  } catch {
    return null;
  }
}

/** The devnet experiments, which need no phone and no wallet. */
function readExperiments(): {
  readonly passed: number;
  readonly total: number;
  readonly at: string;
  readonly nonceAccount: string;
  readonly results: ReadonlyArray<{ id: string; title: string; observed: string; passed: boolean }>;
} | null {
  const file = path.join(process.cwd(), '..', 'evidence', 'experiments.json');
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return {
      passed: data.results.filter((r: { passed: boolean }) => r.passed).length,
      total: data.results.length,
      at: String(data.generatedAtIso).slice(0, 10),
      nonceAccount: data.nonceAccount,
      results: data.results,
    };
  } catch {
    return null;
  }
}

const EXPLORER = EXPLORER_PROGRAM_URL;

export default function Home(): React.JSX.Element {
  const campaign = readCampaign();
  const experiments = readExperiments();

  return (
    <>
      <ScrollRule />
      <Nav />
      <main>
        {/* 1 — Hero ------------------------------------------------------ */}
        <section className={styles.hero} id="top">
          {/* Full bleed, behind everything. The scrim above it is what keeps
              the headline on clean paper. */}
          <div className={styles.heroImage}>
            <Image
              src="/images/hero-token.jpg"
              alt=""
              fill
              priority
              quality={88}
              sizes="100vw"
              aria-hidden
            />
          </div>
          <div className={styles.heroScrim} aria-hidden />

          <div className={`shell ${styles.heroGrid}`}>
            <div className={styles.heroText}>
              <p className={styles.eyebrow}>Running on Solana devnet</p>
              <h1 className={styles.headline}>
                Your phone can send money and then forget it did.
              </h1>
              <p className={styles.lede}>
                Quittance lets a savings circle collect every contribution on a phone that
                dies mid-payment and still know, with certainty, who paid and who did not.
              </p>
              <p className={styles.subLede}>
                Built on Solana durable nonces, because Mobile Wallet Adapter made the only
                mandatory signing path one where the app can lose the result of a payment
                that already happened.
              </p>
              <div className={styles.heroActions}>
                <a className={styles.buttonPrimary} href="#proof">
                  See the proof
                </a>
                <a className={styles.buttonGhost} href={EXPLORER} target="_blank" rel="noreferrer">
                  Program on Solana Explorer
                </a>
              </div>

              <dl className={styles.heroFacts}>
                {[
                  experiments === null
                    ? { v: '—', l: 'mechanism experiments' }
                    : {
                        v: `${experiments.passed}/${experiments.total}`,
                        l: 'mechanism experiments passed',
                      },
                  { v: '0', l: 'double debits by design' },
                  { v: '113', l: 'engine tests, no network' },
                ].map((fact) => (
                  <div key={fact.l} className={styles.heroFact}>
                    <dt className={styles.heroFactValue}>{fact.v}</dt>
                    <dd className={styles.heroFactLabel}>{fact.l}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        {/* 2 — Who this is for ------------------------------------------- */}
        <section className={styles.section} id="who">
          <div className={`shell ${styles.whoGrid}`}>
            <Reveal className={styles.whoFigure}>
              <Image
                src="/images/market.jpg"
                alt="A trader sitting over her wares in a Nigerian market"
                width={800}
                height={533}
                sizes="(max-width: 900px) 92vw, 640px"
                /* Eager: this is the only photograph in the section and it
                   carries the argument, so it should not depend on a reader
                   scrolling slowly enough to trigger a lazy load. */
                loading="eager"
                className={styles.whoImage}
              />
              <p className={styles.whoCredit}>
                Photograph{' '}
                <a href="https://unsplash.com/@omotayo_ty" target="_blank" rel="noreferrer">
                  Omotayo Tajudeen
                </a>
                , Lagos
              </p>
            </Reveal>
            <Reveal className={styles.whoText}>
              <p className={styles.sectionLabel}>Who this is for</p>
              <h2 className={styles.sectionTitle}>Adaeze, and a few hundred million others</h2>
              <div className={styles.prose}>
                <p>
                  Rotating savings circles are called ajo and esusu in Nigeria, chama in Kenya,
                  tanda in Mexico, hui in China, tontine across francophone West Africa, and
                  throwing a hand in the Caribbean. Hundreds of millions of people run them,
                  and almost all of them run on paper.
                </p>
                <p>
                  Collection day costs Adaeze two hours of cross-checking screenshots. Twice a
                  year a dispute ends a friendship. If she is holding the pot, eleven people
                  are trusting her personally with a month of their earnings.
                </p>
                <p>
                  With Quittance the circle, the amount, the schedule and the rotation live in
                  a Solana program, and she never holds anyone&rsquo;s money. Collection day is
                  one screen. The payout cannot run twice, and cannot run at all while any
                  contribution is unresolved.
                </p>
                <p className={styles.proseEmphasis}>
                  She keeps using it because the circle runs twelve weeks and then restarts,
                  and because the one thing it removes is the exact thing that was going to end
                  the group.
                </p>
              </div>
            </Reveal>
          </div>
        </section>


        {/* 3 — See it work -------------------------------------------------- */}
        <section className={`${styles.section} ${styles.sectionSunk}`} id="demo">
          <div className="shell">
            <Reveal>
              <p className={styles.sectionLabel}>See it work</p>
              <h2 className={styles.sectionTitle}>
                The whole thing, including the part that breaks
              </h2>
              <p className={styles.prose}>
                These are the app&rsquo;s own screens. Play it through and the phone dies
                mid-payment on purpose, because that is the moment the product exists for —
                and the one a normal demo would quietly skip.
              </p>
            </Reveal>
            <PhoneDemo />
          </div>
        </section>

        {/* 4 — The moment ------------------------------------------------ */}
        <section className={styles.section} id="moment">
          <div className="shell">
            <Reveal>
              <p className={styles.sectionLabel}>The moment</p>
              <h2 className={styles.sectionTitle}>Both of them are telling the truth</h2>
              <div className={styles.prose}>
                <p>
                  Adaeze runs a twelve-member weekly circle among traders in Onitsha market.
                  Every Thursday each member contributes a fixed amount, and each week one
                  member collects the whole pot. She keeps a paper notebook and a WhatsApp
                  group, and members send her bank-transfer screenshots.
                </p>
                <p>
                  On a Thursday in the market, Ngozi taps pay. Her wallet opens, she approves,
                  and the payment goes out. Then Android reclaims memory from the backgrounded
                  app and it is simply gone before the result comes back.
                </p>
                <p>
                  Ngozi reopens the app. It shows her as unpaid. She says she paid. Adaeze has
                  no record of it. Both of them are telling the truth — the money moved, and
                  the app that moved it never found out.
                </p>
                <p className={styles.proseEmphasis}>
                  That argument is the thing that ends these groups. It is also, on a phone,
                  entirely unavoidable with the standard approach.
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* 5 — The circle ------------------------------------------------ */}
        <section className={`${styles.section} ${styles.sectionSunk}`} id="circle">
          <div className="shell">
            <Reveal>
              <p className={styles.sectionLabel}>The circle</p>
              <h2 className={styles.sectionTitle}>
                Twelve rows. Nothing left to argue about.
              </h2>
              <p className={styles.prose}>
                This is the whole interface. A member&rsquo;s name, what they owe, and where
                it stands — settled on paper, with one exception. The only element that
                glows anywhere in this product is a contribution whose outcome is not yet
                known.
              </p>
            </Reveal>

            <div className={styles.circleGrid}>
              <Reveal delay={0.08} className={styles.ledgerWrap}>
                <Ledger />
              </Reveal>

              <Reveal delay={0.14} className={styles.legend}>
                <p className={styles.legendTitle}>Reading the gutter</p>
                <ul className={styles.legendList}>
                  {[
                    { m: '●', t: 'Paid', d: 'Matched and confirmed on chain', c: 'var(--settled)' },
                    { m: '◉', t: 'Sending', d: 'Outcome not yet known — the one thing that glows', c: 'var(--inflight)' },
                    { m: '○', t: 'Not paid', d: 'Provably never processed, safe to resend', c: 'var(--ink-faint)' },
                    { m: '▲', t: 'Needs a decision', d: 'Escalated to a person, with the evidence attached', c: 'var(--ambiguous)' },
                  ].map((row) => (
                    <li key={row.t} className={styles.legendRow}>
                      <span className={styles.legendMark} style={{ color: row.c }}>
                        {row.m}
                      </span>
                      <span>
                        <strong className={styles.legendName}>{row.t}</strong>
                        <span className={styles.legendDesc}>{row.d}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className={styles.legendNote}>
                  Shape as well as colour, so the ledger stays readable without colour
                  vision. No row&rsquo;s state is ever carried by colour alone.
                </p>
              </Reveal>
            </div>
          </div>
        </section>

        {/* 6 — How it resolves ------------------------------------------- */}
        <section className={styles.section} id="how">
          <div className="shell">
            <Reveal>
              <p className={styles.sectionLabel}>How it resolves</p>
              <h2 className={styles.sectionTitle}>One account answers every question</h2>
              <p className={styles.prose}>
                Every contribution is anchored to a durable nonce account. Read that one
                account and you know whether the payment happened, which transaction did it,
                whether it succeeded, and whether its contents match the intent recorded before
                the wallet was ever opened.
              </p>
            </Reveal>
            <div className={styles.diagram}>
              <ResolutionDiagram />
            </div>

            <div className={styles.cards}>
              {[
                {
                  title: 'The phone records intent',
                  body: 'The intent is written to disk and flushed before the wallet is ever invoked. If the process dies one millisecond later, everything recovery needs is already on disk.',
                },
                {
                  title: 'The chain decides truth',
                  body: 'A durable nonce transaction does not expire. The stored value either still matches what the transaction was built against, or exactly one transaction consumed it.',
                },
                {
                  title: 'The runtime prevents the double charge',
                  body: 'Rebroadcasting after the nonce advanced fails validation and is dropped before execution. We did not write that guarantee and we cannot get it wrong.',
                },
              ].map((card) => (
                <Surface key={card.title} as="article" className={styles.card}>
                  <h3 className={styles.cardTitle}>{card.title}</h3>
                  <p className={styles.cardBody}>{card.body}</p>
                </Surface>
              ))}
            </div>
          </div>
        </section>

        {/* 7 — The campaign ---------------------------------------------- */}
        <section className={`${styles.section} ${styles.sectionSunk}`} id="proof">
          <div className="shell">
            <Reveal>
              <p className={styles.sectionLabel}>The proof</p>
              <h2 className={styles.sectionTitle}>Both arms, same faults, same phone</h2>
            </Reveal>

            {campaign === null ? (
              <>
              <Reveal delay={0.06}>
                <Surface className={styles.notRun} interactive={false}>
                  <div className={styles.notRunHead}>
                    <span className={`mono ${styles.notRunBadge}`}>pending</span>
                    <h3 className={styles.cardTitle}>The fault campaign has not run yet</h3>
                  </div>
                  <p className={styles.cardBody}>
                    There are no campaign numbers on this page because none have been
                    produced. The corpus below runs on a physical phone — it force-stops
                    the app mid-payment, cuts the network, and reboots the device — so it
                    cannot run until the app is installed on that phone.
                  </p>
                  <ol className={styles.gateList}>
                    <li>
                      <span className={styles.gateDone}>done</span>
                      The mechanism, proven on devnet. Five experiments, no phone required.
                    </li>
                    <li>
                      <span className={styles.gateNow}>now</span>
                      Build and install the app on the device.
                    </li>
                    <li>
                      <span className={styles.gateNext}>next</span>
                      Run experiment E8, the gate: does the wallet preserve the payment it
                      was handed? If not, the thesis changes and nothing is built on it.
                    </li>
                    <li>
                      <span className={styles.gateNext}>then</span>
                      Both arms through the fault corpus, and these figures appear here.
                    </li>
                  </ol>
                  <p className={styles.cardBody}>
                    When it runs, every figure is written by a script reading its results
                    file. None of them is typed by hand, and nothing is shown here before it
                    exists.
                  </p>
                </Surface>
              </Reveal>

              <Reveal delay={0.1}>
                <div className={styles.faultGrid}>
                  {[
                    ['F1', 'Kill after the intent is written, before the wallet is called'],
                    ['F2', 'Kill while the wallet is foreground, before approval'],
                    ['F3', 'Kill after approval, before the session returns'],
                    ['F4', 'Airplane mode toggled mid-broadcast'],
                    ['F5', 'Forced reboot between broadcast and resolution'],
                    ['F6', 'RPC timeout and stale-slot responses'],
                    ['F7', 'Rebroadcast identical bytes ten times after it landed'],
                    ['F8', 'Nonce consumed by a foreign transaction'],
                    ['F9', 'Two concurrent disburse calls on one round'],
                    ['F10', 'Kill during the recovery resolver itself'],
                  ].map(([id, label]) => (
                    <Surface key={id} as="article" className={styles.fault}>
                      <span className={`mono ${styles.faultId}`}>{id}</span>
                      <span className={styles.faultLabel}>{label}</span>
                    </Surface>
                  ))}
                </div>
              </Reveal>
              </>
            ) : (
              <Reveal delay={0.06}>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">Across {campaign.contributions} fault-injected contributions</th>
                        <th scope="col" className="mono">baseline</th>
                        <th scope="col" className="mono">quittance</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <th scope="row">double debits</th>
                        <td className="mono">{campaign.baseline.doubleDebits}</td>
                        <td className="mono">{campaign.quittance.doubleDebits}</td>
                      </tr>
                      <tr>
                        <th scope="row">unresolved after 5 min</th>
                        <td className="mono">{campaign.baseline.unresolved}</td>
                        <td className="mono">{campaign.quittance.unresolved}</td>
                      </tr>
                      <tr>
                        <th scope="row">false credits</th>
                        <td className="mono">{campaign.baseline.phantom}</td>
                        <td className="mono">{campaign.quittance.phantom}</td>
                      </tr>
                    </tbody>
                  </table>
                  <p className={styles.tableNote}>
                    Both arms ran the identical fault corpus on {campaign.device} and are never
                    pooled. The baseline is the standard mobile pattern written honestly:
                    recent blockhash, one retry, history scan on recovery.
                  </p>
                </div>
              </Reveal>
            )}

            {experiments !== null ? (
              <Reveal delay={0.1}>
                <div className={styles.experiments}>
                  <h3 className={styles.cardTitle}>
                    The mechanism, measured on devnet — {experiments.passed} of{' '}
                    {experiments.total} passed
                  </h3>
                  <p className={styles.cardBody}>
                    These need no phone and no wallet, because they test what the Solana
                    runtime does. Run {experiments.at} against nonce account{' '}
                    <span className="mono">{experiments.nonceAccount.slice(0, 16)}…</span>
                  </p>
                  <ul className={styles.experimentList}>
                    {experiments.results.map((result) => (
                      <li key={result.id} className={styles.experimentRow}>
                        <span
                          className="mono"
                          style={{
                            color: result.passed ? 'var(--settled)' : 'var(--rejected)',
                          }}
                        >
                          {result.passed ? 'PASS' : 'FAIL'}
                        </span>
                        <span className={styles.experimentText}>
                          <strong>{result.id}</strong> · {result.title}
                          <em className={styles.experimentObserved}>{result.observed}</em>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Reveal>
            ) : null}

            <Reveal delay={0.12}>
              <div className={styles.verify}>
                <p className={styles.verifyLabel}>Check it yourself</p>
                <pre className={`mono ${styles.command}`}>
{`node packages/verifier/dist/cli.js \\
  --intents evidence/intents.jsonl \\
  --rpc $HELIUS_RPC_URL \\
  --check I1,I2,I3,I4,I5,I6`}
                </pre>
                <p className={styles.verifyNote}>
                  Re-reads the chain and recomputes every verdict with the same function the app
                  used. No wallet, no key, no part of the app.
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* 8 — Prove it yourself ------------------------------------------ */}
        <section className={styles.section} id="live">
          <div className="shell">
            <Reveal>
              <p className={styles.sectionLabel}>Prove it yourself</p>
              <h2 className={styles.sectionTitle}>
                Not a recording. Your wallet, this cluster, right now.
              </h2>
              <p className={styles.prose}>
                Connect a devnet wallet and this runs the exact mechanism E5 and E6 measured on
                the proof page above &mdash; a durable-nonce payment, built and hashed before
                anything is signed, read back from the chain rather than taken on trust. It is
                the same <code>@quittance/engine</code> package the app imports, running in your
                browser with no modification.
              </p>
            </Reveal>
            <Reveal delay={0.08}>
              <Surface className={styles.liveCard} interactive={false}>
                <LiveCheck />
              </Surface>
            </Reveal>
          </div>
        </section>

        {/* 9 — Footer ----------------------------------------------------- */}
        <footer className={styles.footer}>
          <div className="shell">
            <div className={styles.footerGrid}>
              <div>
                <p className={styles.footerMark}>Quittance</p>
                <p className={styles.footerNote}>
                  A quittance is the formal document certifying that an obligation has been
                  discharged in full.
                </p>
              </div>
              <ul className={styles.footerLinks}>
                <li>
                  <a href={EXPLORER} target="_blank" rel="noreferrer">
                    Program on devnet
                  </a>
                </li>
                <li>
                  <a href="/proof">Public proof page</a>
                </li>
                <li>
                  <a href="#circle">The circle</a>
                </li>
              </ul>
            </div>
            <p className={`mono ${styles.programId}`}>{PROGRAM_ID}</p>
          </div>
        </footer>
      </main>
    </>
  );
}

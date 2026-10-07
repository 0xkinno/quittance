#!/usr/bin/env node
/**
 * The offline verifier.
 *
 * ```
 * node packages/verifier/dist/cli.js \
 *   --intents evidence/intents.jsonl \
 *   --rpc $HELIUS_RPC_URL \
 *   --check I1,I2,I3,I4,I5,I6
 * ```
 *
 * It re-reads the chain, recomputes every verdict with the same pure function
 * the app uses, recomputes the requested invariants, and prints one PASS or
 * FAIL line per check. It imports nothing from the app. It needs no wallet and
 * no key, and it never sends a transaction.
 *
 * Exit code is 0 only when every check passes. A verifier whose exit code did
 * not depend on its findings could not be put in CI, and a proof nobody runs
 * is not a proof.
 */

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import { Connection } from '@solana/web3.js';
import { Web3ChainReader } from '@quittance/engine';
import type { InvariantId, RoundView } from '@quittance/engine';

import { parseIntentLog, IntentLogParseError } from './log.ts';
import { verify } from './verify.ts';
import type { VerificationReport } from './verify.ts';

const ALL_INVARIANTS: readonly InvariantId[] = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6'];

interface Options {
  readonly intentsPath: string;
  readonly rpcUrl: string;
  readonly invariantIds: readonly InvariantId[];
  readonly roundsPath: string | null;
  readonly outPath: string | null;
  readonly arm: 'quittance' | 'baseline' | null;
  readonly quiet: boolean;
}

const USAGE = `quittance-verify — recompute every verdict from a log plus the chain

  --intents <path>    newline-delimited intent log (required)
  --rpc <url>         RPC endpoint (required, or set HELIUS_RPC_URL)
  --check <ids>       comma-separated invariants to check (default: all six)
  --rounds <path>     JSON array of round views, for I3 and I4
  --out <path>        write the full report as JSON
  --arm <name>        restrict to one arm: quittance | baseline
  --quiet             print only the PASS/FAIL lines
  --help

Exit code is 0 only when every requested check passes.
`;

function parseArgs(argv: readonly string[]): Options | null {
  const args = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.add(key);
    } else {
      args.set(key, next);
      i += 1;
    }
  }

  if (flags.has('help')) return null;

  const intentsPath = args.get('intents');
  const rpcUrl = args.get('rpc') ?? process.env['HELIUS_RPC_URL'];

  if (intentsPath === undefined) {
    throw new Error('--intents is required. It is the log whose verdicts are being rechecked.');
  }
  if (rpcUrl === undefined || rpcUrl.length === 0) {
    throw new Error(
      '--rpc is required, or set HELIUS_RPC_URL. The verifier re-reads the chain itself; ' +
        'that is what makes it independent of the app.',
    );
  }

  const requested = args.get('check');
  const invariantIds =
    requested === undefined
      ? ALL_INVARIANTS
      : requested.split(',').map((raw) => {
          const id = raw.trim().toUpperCase();
          if (!(ALL_INVARIANTS as readonly string[]).includes(id)) {
            throw new Error(`Unknown invariant ${id}. Valid ids: ${ALL_INVARIANTS.join(', ')}`);
          }
          return id as InvariantId;
        });

  const armRaw = args.get('arm');
  if (armRaw !== undefined && armRaw !== 'quittance' && armRaw !== 'baseline') {
    throw new Error('--arm must be quittance or baseline. The two arms are never pooled.');
  }

  return {
    intentsPath,
    rpcUrl,
    invariantIds,
    roundsPath: args.get('rounds') ?? null,
    outPath: args.get('out') ?? null,
    arm: armRaw ?? null,
    quiet: flags.has('quiet'),
  };
}

async function loadRounds(path: string | null): Promise<readonly RoundView[]> {
  if (path === null) return [];
  const contents = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(contents);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON array of round views.`);
  }
  return parsed as readonly RoundView[];
}

/** The endpoint host, never the full URL, so an API key is not printed. */
function hostOf(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return 'unparseable-endpoint';
  }
}

function printReport(report: VerificationReport, options: Options): void {
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  if (!options.quiet) {
    out('');
    out('quittance-verify');
    out(`  log            ${options.intentsPath}`);
    out(`  rpc host       ${report.rpcHost}`);
    out(`  arm            ${options.arm ?? 'all (reported separately below)'}`);
    out(`  slots read     ${report.slotsRead}`);
    out(`  recomputed     ${report.slotsRecomputed}`);
    if (report.slotsUnreadable > 0) {
      out(`  unreadable     ${report.slotsUnreadable}  (counted as a failure, never as a pass)`);
    }
    out(`  elapsed        ${report.finishedAtMs - report.startedAtMs} ms`);
    out('');

    const byArm = new Map<string, number>();
    for (const slot of report.slots) {
      const key = `${slot.arm ?? 'unattributed'} · ${slot.recomputedState}`;
      byArm.set(key, (byArm.get(key) ?? 0) + 1);
    }
    if (byArm.size > 0) {
      out('  recomputed states');
      for (const [key, count] of [...byArm.entries()].sort()) {
        out(`    ${key.padEnd(40)} ${count}`);
      }
      out('');
    }
  }

  // The two divergence kinds are printed under separate headings. A reader
  // must always be able to tell whether the data or the logic was wrong.
  const hashFailures = report.divergences.filter(
    (divergence) => divergence.kind === 'INTENT_HASH_FAILURE',
  );
  const verdictDivergences = report.divergences.filter(
    (divergence) => divergence.kind === 'VERDICT_DIVERGENCE',
  );

  out(
    `${hashFailures.length === 0 ? 'PASS' : 'FAIL'}  INTENT_HASH   ${
      hashFailures.length
    } stored intents edited since they were written`,
  );
  for (const failure of hashFailures) {
    out(`        ${failure.slotId}`);
    out(`          recorded   ${failure.recorded}`);
    out(`          recomputed ${failure.recomputed}`);
  }

  out(
    `${verdictDivergences.length === 0 ? 'PASS' : 'FAIL'}  VERDICTS      ${
      verdictDivergences.length
    } recorded verdicts differ from recomputation`,
  );
  for (const divergence of verdictDivergences) {
    out(`        ${divergence.slotId}: ${divergence.detail}`);
  }

  for (const invariant of report.invariants) {
    out(
      `${invariant.pass ? 'PASS' : 'FAIL'}  ${invariant.invariant.padEnd(13)} ${
        invariant.title
      } — ${invariant.checked} checked, ${invariant.violations.length} violations`,
    );
    for (const violation of invariant.violations) {
      out(`        ${violation.subject}: ${violation.detail}`);
    }
    if (!options.quiet) {
      for (const note of invariant.notes) {
        out(`        note: ${note}`);
      }
    }
  }

  out('');
  out(report.pass ? 'PASS  all requested checks hold.' : 'FAIL  see the lines above.');
  out('');
}

async function main(): Promise<number> {
  let options: Options | null;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }

  if (options === null) {
    process.stdout.write(USAGE);
    return 0;
  }

  let entries;
  try {
    entries = parseIntentLog(await readFile(options.intentsPath, 'utf8'));
  } catch (error) {
    if (error instanceof IntentLogParseError) {
      // A malformed line is a failure, never a skipped row: a clean pass over
      // a log that was mostly not read is the worst outcome this tool has.
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    process.stderr.write(
      `Could not read ${options.intentsPath}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 2;
  }

  if (entries.length === 0) {
    process.stderr.write(
      `${options.intentsPath} contains no intents. There is nothing to verify, which is ` +
        'not the same as everything passing.\n',
    );
    return 2;
  }

  const rounds = await loadRounds(options.roundsPath);
  const connection = new Connection(options.rpcUrl, 'finalized');
  const reader = new Web3ChainReader(connection);

  const report = await verify({
    entries,
    reader,
    rpcHost: hostOf(options.rpcUrl),
    invariantIds: options.invariantIds,
    rounds,
    arm: options.arm,
    onProgress: options.quiet
      ? undefined
      : (slotId, index, total) => {
          process.stderr.write(`\r  reading ${index}/${total}  ${slotId.slice(0, 48)}   `);
        },
  });

  if (!options.quiet) process.stderr.write('\r\x1b[2K');
  printReport(report, options);

  if (options.outPath !== null) {
    await writeFile(options.outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    if (!options.quiet) {
      process.stdout.write(`  full report written to ${options.outPath}\n\n`);
    }
  }

  return report.pass ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `quittance-verify stopped: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  },
);

#!/usr/bin/env node
/**
 * Generate README.md from the evidence.
 *
 * The rule this script exists to enforce:
 *
 *   **Every number in any document is produced by a script reading a real
 *   results file. No number is ever typed by hand.**
 *
 * So the README is a template with named placeholders, and this fills them
 * from `evidence/`. A placeholder whose evidence file does not exist is
 * rendered as an explicit "not yet measured" rather than as a zero, a dash, or
 * a plausible-looking guess — a document that invents a number to avoid
 * looking incomplete is the exact failure this project is about.
 *
 *   node scripts/generate_readme.mjs            write README.md
 *   node scripts/generate_readme.mjs --check    fail if README.md is stale
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const TEMPLATE = 'docs/README.template.md';
const OUTPUT = 'README.md';

const check = process.argv.includes('--check');

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    process.stderr.write(
      `  ${path} exists but could not be parsed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(2);
  }
}

const campaign = readJson('evidence/campaign.json');
const experiments = readJson('evidence/experiments.json');
const manifest = readJson('evidence/run_manifest.json');

/** What a placeholder renders as when its evidence does not exist yet. */
const NOT_MEASURED = '_not yet measured_';

const missing = [];

function value(label, produce) {
  try {
    const result = produce();
    if (result === null || result === undefined || result === '') {
      missing.push(label);
      return NOT_MEASURED;
    }
    return String(result);
  } catch {
    missing.push(label);
    return NOT_MEASURED;
  }
}

function arm(name) {
  return campaign?.summary?.arms?.find((entry) => entry.arm === name) ?? null;
}

const quittance = arm('quittance');
const baseline = arm('baseline');

// ---------------------------------------------------------------------------
// Substitutions
// ---------------------------------------------------------------------------

const substitutions = {
  // --- the break campaign ---
  CONTRIBUTIONS: value('contributions', () => campaign?.summary?.contributions),
  Q_DOUBLE_DEBITS: value('quittance double debits', () => quittance?.doubleDebits),
  Q_PHANTOM_CREDITS: value('quittance phantom credits', () => quittance?.phantomCredits),
  Q_UNRESOLVED: value('quittance unresolved', () => quittance?.unresolvedAfterFiveMinutes),
  Q_ESCALATIONS: value('quittance escalations', () => quittance?.ambiguousEscalations),
  Q_MEDIAN_MS: value('quittance median verdict', () => quittance?.medianTimeToVerdictMs),
  Q_RUNS: value('quittance runs', () => quittance?.runs),

  B_DOUBLE_DEBITS: value('baseline double debits', () => baseline?.doubleDebits),
  B_PHANTOM_CREDITS: value('baseline phantom credits', () => baseline?.phantomCredits),
  B_UNRESOLVED: value('baseline unresolved', () => baseline?.unresolvedAfterFiveMinutes),
  B_RUNS: value('baseline runs', () => baseline?.runs),

  // --- the device the numbers came from ---
  DEVICE_MODEL: value('device model', () => campaign?.manifest?.device?.model),
  ANDROID_VERSION: value('android version', () => campaign?.manifest?.device?.androidVersion),
  WALLET_VERSION: value('wallet version', () => campaign?.manifest?.device?.walletVersion),
  RUN_ID: value('run id', () => campaign?.manifest?.runId),
  COMMIT: value('commit', () => campaign?.manifest?.commit ?? manifest?.commit),

  // --- the devnet experiments, which do not need the phone ---
  EXPERIMENTS_PASSED: value(
    'experiments passed',
    () => experiments?.results?.filter((r) => r.passed).length,
  ),
  EXPERIMENTS_TOTAL: value('experiments total', () => experiments?.results?.length),
  E6A_EFFECTS: value(
    'E6a effects',
    () => experiments?.results?.find((r) => r.id === 'E6a')?.evidence?.effects,
  ),
  E6A_RESENDS: value(
    'E6a resends',
    () => experiments?.results?.find((r) => r.id === 'E6a')?.evidence?.resendsAnswered,
  ),
  E6B_ERROR: value('E6b runtime error', () => {
    const raw = experiments?.results?.find((r) => r.id === 'E6b')?.evidence?.sendError;
    if (typeof raw !== 'string') return null;
    // The runtime's own phrase, lifted out of web3.js's wrapper text. That
    // phrase is the whole finding; the SDK's advice around it is not.
    return /Blockhash not found/i.test(raw) ? 'Blockhash not found' : raw.slice(0, 80);
  }),
  EXPERIMENT_NONCE_ACCOUNT: value('experiment nonce account', () => experiments?.nonceAccount),
  EXPERIMENTS_AT: value('experiments timestamp', () => experiments?.generatedAtIso?.slice(0, 10)),

  // --- deployment ---
  PROGRAM_ID: value('program id', () => manifest?.programId ?? readProgramIdFromAnchorToml()),
  CLUSTER: value('cluster', () => experiments?.cluster ?? 'devnet'),
  RPC_HOST: value('rpc host', () => experiments?.rpcHost),
};

function readProgramIdFromAnchorToml() {
  if (!existsSync('program/Anchor.toml')) return null;
  const toml = readFileSync('program/Anchor.toml', 'utf8');
  return /^quittance\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

if (!existsSync(TEMPLATE)) {
  process.stderr.write(`  ${TEMPLATE} does not exist.\n`);
  process.exit(2);
}

const template = readFileSync(TEMPLATE, 'utf8');

const unknownPlaceholders = [];
const rendered = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, name) => {
  if (!(name in substitutions)) {
    unknownPlaceholders.push(name);
    return `{{${name}}}`;
  }
  return substitutions[name];
});

if (unknownPlaceholders.length > 0) {
  // A placeholder with no source is a number somebody intended to type by
  // hand. Refusing is the whole point of this script.
  process.stderr.write(
    `  The template references placeholders with no evidence source:\n` +
      unknownPlaceholders.map((name) => `      {{${name}}}`).join('\n') +
      '\n',
  );
  process.exit(2);
}

if (check) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
  if (current !== rendered) {
    process.stderr.write(
      `  ${OUTPUT} is stale. Run: node scripts/generate_readme.mjs\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`  ${OUTPUT} is up to date.\n`);
  process.exit(0);
}

writeFileSync(OUTPUT, rendered, 'utf8');

process.stdout.write(`\n  wrote ${OUTPUT}\n`);
process.stdout.write(`  ${Object.keys(substitutions).length} values substituted\n`);

if (missing.length > 0) {
  process.stdout.write(
    `  ${missing.length} rendered as "${NOT_MEASURED}" because their evidence does not exist yet:\n`,
  );
  for (const label of missing) process.stdout.write(`      ${label}\n`);
  process.stdout.write('\n');
} else {
  process.stdout.write('  every number came from a results file\n\n');
}

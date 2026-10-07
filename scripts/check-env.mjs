#!/usr/bin/env node
/**
 * Startup assertion for the environment.
 *
 * Run before anything that produces a number. It fails loudly rather than
 * letting a campaign run finish and hand back figures that look like evidence
 * and are not.
 *
 *   node scripts/check-env.mjs                 validate .env
 *   node scripts/check-env.mjs --probe-device  also read the phone over adb
 *                                              and write what it found back
 *                                              into .env
 *   node scripts/check-env.mjs --balances      also read both devnet balances
 *
 * Exit code 0 only when every check passes.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const ENV_PATH = '.env';
// Minimum balances, by role.
//
// The payer deploys the program, funds a rent-exempt nonce account per
// contribution slot, and pays for every test transfer, so it needs real
// headroom. The adversary signs one advance transaction to take a nonce out
// from under a pending contribution in fault F8 — that is its entire job, and
// holding two SOL against it would just strand faucet funds.
const MINIMUM_SOL = { PAYER: 2, ADVERSARY: 0.5 };

const flags = new Set(process.argv.slice(2));
const failures = [];
const warnings = [];
const facts = [];

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

/**
 * A deliberately small parser.
 *
 * No dotenv dependency: this file has to run before anything is installed, and
 * a validator that cannot run until its own dependencies are present is not a
 * validator.
 */
function parseEnvFile(path) {
  if (!existsSync(path)) return null;
  const values = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const text = line.trim();
    if (text.length === 0 || text.startsWith('#')) continue;
    const separator = text.indexOf('=');
    if (separator < 0) continue;
    const key = text.slice(0, separator).trim();
    let value = text.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

const env = parseEnvFile(ENV_PATH);

if (env === null) {
  process.stderr.write(
    `\n  ${ENV_PATH} does not exist.\n\n` +
      '    cp .env.example .env\n\n' +
      '  then fill in HELIUS_RPC_URL. Nothing that produces a number will run\n' +
      '  until it is set.\n\n',
  );
  process.exit(2);
}

const read = (key) => {
  const fromProcess = process.env[key];
  if (fromProcess !== undefined && fromProcess.length > 0) return fromProcess;
  const fromFile = env.get(key);
  return fromFile !== undefined && fromFile.length > 0 ? fromFile : null;
};

// --- RPC -------------------------------------------------------------------

const rpcUrl = read('HELIUS_RPC_URL');

if (rpcUrl === null) {
  failures.push(
    'HELIUS_RPC_URL is not set.\n' +
      '      Get it from https://dashboard.helius.dev — create a project, pick\n' +
      '      Devnet, copy the RPC URL, and paste it into .env.',
  );
} else {
  let parsed = null;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    failures.push(`HELIUS_RPC_URL is not a valid URL: ${rpcUrl}`);
  }

  if (parsed !== null) {
    if (parsed.protocol !== 'https:') {
      failures.push(
        `HELIUS_RPC_URL must be https, and it is ${parsed.protocol}. An RPC URL carries an ` +
          'API key in its query string.',
      );
    }
    // The assertion the task asked for, and the reason for it.
    if (parsed.host === 'api.devnet.solana.com' || parsed.host === 'api.mainnet-beta.solana.com') {
      failures.push(
        `HELIUS_RPC_URL still points at the public endpoint (${parsed.host}).\n` +
          '      The public endpoint rate-limits hard enough that the campaign\'s timing\n' +
          '      figures stop meaning anything, and a run against it would produce\n' +
          '      numbers that look like evidence. Use the Helius devnet endpoint.',
      );
    }
    if (parsed.host.includes('helius') && !parsed.searchParams.has('api-key')) {
      warnings.push(
        'HELIUS_RPC_URL has no api-key parameter. Helius will rate-limit it as anonymous.',
      );
    }
    // Printed as host only, so a key never lands in a log or a screenshot.
    facts.push(['rpc host', parsed.host]);
  }
}

// --- cluster ---------------------------------------------------------------

const cluster = read('SOLANA_CLUSTER');

if (cluster === null) {
  failures.push('SOLANA_CLUSTER is not set. Expected devnet.');
} else if (cluster === 'mainnet-beta') {
  if (read('QUITTANCE_ALLOW_MAINNET') === null) {
    failures.push(
      'SOLANA_CLUSTER is mainnet-beta. Everything in this build targets devnet, and\n' +
        '      nothing here should reach mainnet by accident. Set QUITTANCE_ALLOW_MAINNET=1\n' +
        '      as well if that is genuinely what you intend.',
    );
  } else {
    warnings.push('SOLANA_CLUSTER is mainnet-beta and mainnet has been explicitly allowed.');
  }
  facts.push(['cluster', cluster]);
} else if (cluster !== 'devnet') {
  failures.push(`SOLANA_CLUSTER is ${cluster}. Expected devnet or mainnet-beta.`);
} else {
  facts.push(['cluster', cluster]);
  if (rpcUrl !== null && rpcUrl.includes('mainnet')) {
    failures.push(
      'SOLANA_CLUSTER is devnet and HELIUS_RPC_URL names mainnet. A campaign run against\n' +
        '      the wrong cluster is worse than no campaign.',
    );
  }
}

// --- keypairs --------------------------------------------------------------

const keypairs = [
  ['PAYER_KEYPAIR_PATH', 'deploys the program and funds test transfers'],
  ['ADVERSARY_KEYPAIR_PATH', 'the independent signer fault F8 needs'],
  ['PROGRAM_KEYPAIR_PATH', 'the program address in declare_id!'],
];

const addresses = new Map();

for (const [key, purpose] of keypairs) {
  const path = read(key);
  if (path === null) {
    failures.push(`${key} is not set (${purpose}).`);
    continue;
  }
  if (!existsSync(path)) {
    failures.push(
      `${key} points at ${path}, which does not exist.\n` +
        '      Generate it with:  node scripts/keygen.mjs .keys/payer.json .keys/adversary.json',
    );
    continue;
  }
  try {
    const bytes = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(bytes) || bytes.length !== 64) {
      failures.push(
        `${key} at ${path} is not a Solana keypair file: expected a 64-byte array, found ` +
          `${Array.isArray(bytes) ? `${bytes.length} bytes` : typeof bytes}.`,
      );
      continue;
    }
    addresses.set(key, path);
  } catch (error) {
    failures.push(
      `${key} at ${path} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// The payer and the adversary must be different wallets. If they were the same
// key, F8 would have one party advancing its own nonce, which demonstrates
// nothing about a foreign consumer.
const payerPath = read('PAYER_KEYPAIR_PATH');
const adversaryPath = read('ADVERSARY_KEYPAIR_PATH');
if (payerPath !== null && adversaryPath !== null && existsSync(payerPath) && existsSync(adversaryPath)) {
  if (readFileSync(payerPath, 'utf8').trim() === readFileSync(adversaryPath, 'utf8').trim()) {
    failures.push(
      'PAYER and ADVERSARY are the same keypair. Fault F8 needs a genuinely independent\n' +
        '      signer; one wallet advancing its own nonce demonstrates nothing.',
    );
  }
}

// --- SKR -------------------------------------------------------------------

const skrMint = read('SKR_MINT');
const skrGenuine = read('SKR_MINT_IS_GENUINE');

if (skrMint === null) {
  warnings.push(
    'SKR_MINT is empty. The nonce lease runs against a stand-in mint, and every\n' +
      '      surface that mentions the lease is labelled accordingly. This is recorded in\n' +
      '      LIMITATIONS.md and is not a failure — but it is not the real thing either.',
  );
  facts.push(['SKR mint', 'stand-in (labelled everywhere)']);
} else {
  if (skrGenuine !== 'true') {
    warnings.push(
      'SKR_MINT is set and SKR_MINT_IS_GENUINE is not true. The lease will still be\n' +
        '      labelled a stand-in. Set SKR_MINT_IS_GENUINE=true only once the address is\n' +
        '      confirmed as the real SKR devnet mint.',
    );
  }
  facts.push(['SKR mint', `${skrMint.slice(0, 8)}… (genuine=${skrGenuine ?? 'false'})`]);
}

// ---------------------------------------------------------------------------
// Device probe
// ---------------------------------------------------------------------------

function adb(args) {
  return execFileSync('adb', args, { encoding: 'utf8', timeout: 20_000 }).trim();
}

if (flags.has('--probe-device')) {
  try {
    const devices = adb(['devices'])
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const ready = devices.filter((line) => line.endsWith('\tdevice'));
    const unauthorized = devices.filter((line) => line.endsWith('\tunauthorized'));

    if (unauthorized.length > 0) {
      failures.push(
        'A device is connected but shows as "unauthorized". Unlock the phone and accept\n' +
          '      the "Allow USB debugging" prompt, then run this again.',
      );
    } else if (ready.length === 0) {
      failures.push(
        'adb lists no device. Check the USB cable is in a data port, that the phone is\n' +
          '      set to File transfer mode, and that USB debugging is on.',
      );
    } else if (ready.length > 1) {
      failures.push(
        `adb lists ${ready.length} devices. The campaign must name one, or a fault could be\n` +
          '      injected into the wrong phone. Unplug the others.',
      );
    } else {
      const serial = ready[0].split('\t')[0];
      const model = adb(['-s', serial, 'shell', 'getprop', 'ro.product.model']);
      const release = adb(['-s', serial, 'shell', 'getprop', 'ro.build.version.release']);
      const fingerprint = adb(['-s', serial, 'shell', 'getprop', 'ro.build.fingerprint']);

      let walletVersion = '';
      const walletPackage = read('WALLET_PACKAGE') ?? 'com.solflare.mobile';
      try {
        const dump = adb(['-s', serial, 'shell', 'dumpsys', 'package', walletPackage]);
        walletVersion = (/versionName=(\S+)/.exec(dump)?.[1] ?? '').trim();
      } catch {
        walletVersion = '';
      }

      if (walletVersion.length === 0) {
        failures.push(
          `The wallet package ${walletPackage} is not installed on the phone.\n` +
            '      Install Solflare from the Play Store, create a wallet, and switch it to\n' +
            '      Devnet. Experiment E7 probes what it actually implements.',
        );
      }

      facts.push(['device', `${model} · Android ${release}`]);
      facts.push(['serial', serial]);
      facts.push(['wallet', walletVersion.length > 0 ? `${walletPackage} ${walletVersion}` : 'not installed']);
      facts.push(['fingerprint', fingerprint]);

      // Written back so every campaign row can be attributed to this device.
      // Numbers from an unidentified phone are not evidence.
      writeBackEnv({
        ANDROID_DEVICE_SERIAL: serial,
        ANDROID_DEVICE_MODEL: model,
        ANDROID_VERSION: release,
        WALLET_VERSION: walletVersion,
      });
    }
  } catch (error) {
    failures.push(
      'adb could not be run. Install Android platform-tools and make sure adb is on PATH.\n' +
        `      (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`,
    );
  }
}

function writeBackEnv(updates) {
  let contents = readFileSync(ENV_PATH, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(contents)) {
      contents = contents.replace(pattern, `${key}=${value}`);
    } else {
      contents += `${contents.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
    }
  }
  writeFileSync(ENV_PATH, contents, 'utf8');
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

if (flags.has('--balances') && rpcUrl !== null) {
  const { Connection, Keypair, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
  const connection = new Connection(rpcUrl, 'confirmed');

  for (const [key, path] of addresses) {
    if (key === 'PROGRAM_KEYPAIR_PATH') continue;
    const bytes = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
    const address = Keypair.fromSecretKey(bytes).publicKey;
    try {
      const lamports = await connection.getBalance(address, 'confirmed');
      const sol = lamports / LAMPORTS_PER_SOL;
      const role = key.replace('_KEYPAIR_PATH', '');
      const minimum = MINIMUM_SOL[role];

      facts.push([role.toLowerCase(), `${address.toBase58()}  ${sol} SOL`]);

      // A role with no threshold is a role this check does not know about,
      // which is a bug in this file rather than a reason to pass it silently.
      if (minimum === undefined) {
        failures.push(
          `${role} has no minimum balance defined, so its funding was not checked. ` +
            'Add one to MINIMUM_SOL rather than letting an unchecked account through.',
        );
      } else if (sol < minimum) {
        failures.push(
          `${role} holds ${sol} SOL and needs at least ${minimum}.\n` +
            `      Fund ${address.toBase58()} at https://faucet.solana.com (pick Devnet).`,
        );
      }
    } catch (error) {
      failures.push(
        `Could not read the balance of ${address.toBase58()}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const out = (line) => process.stdout.write(`${line}\n`);

out('');
out('  quittance environment');
out('');
for (const [label, value] of facts) {
  out(`    ${label.padEnd(14)} ${value}`);
}
if (facts.length > 0) out('');

for (const warning of warnings) {
  out(`  WARN   ${warning}`);
}
if (warnings.length > 0) out('');

if (failures.length === 0) {
  out('  PASS   the environment is ready.');
  out('');
  process.exit(0);
}

for (const failure of failures) {
  out(`  FAIL   ${failure}`);
}
out('');
out(`  ${failures.length} problem${failures.length === 1 ? '' : 's'}. Nothing that produces a number will run until they are fixed.`);
out('');
process.exit(1);

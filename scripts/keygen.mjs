#!/usr/bin/env node
/**
 * Generate devnet keypairs in the exact format the Solana CLI reads.
 *
 * Why this exists rather than `solana-keygen`: the keypairs are needed before
 * the Solana CLI finishes installing, so that funding can start immediately.
 * The output is byte-identical to what `solana-keygen new -o` writes — a JSON
 * array of the 64 secret-key bytes — so `solana address -k`, `anchor deploy`
 * and every Solana tool read these files without knowing the difference.
 *
 * Refuses to overwrite an existing key. A funded keypair silently replaced is
 * a funded keypair lost, and on devnet that costs a faucet round trip; the
 * same mistake on mainnet would cost real money, so the guard is
 * unconditional rather than environment-dependent.
 *
 *   node scripts/keygen.mjs .keys/payer.json .keys/adversary.json
 */

import { Keypair } from '@solana/web3.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const targets = process.argv.slice(2);

if (targets.length === 0) {
  process.stderr.write(
    'usage: node scripts/keygen.mjs <path> [<path> ...]\n' +
      '       writes each as a Solana CLI keypair file and prints its address\n',
  );
  process.exit(2);
}

const results = [];

for (const target of targets) {
  const path = resolve(target);

  if (existsSync(path)) {
    results.push({ target, address: null, note: 'already exists, left untouched' });
    continue;
  }

  mkdirSync(dirname(path), { recursive: true });
  const keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), {
    encoding: 'utf8',
    mode: 0o600,
  });
  results.push({ target, address: keypair.publicKey.toBase58(), note: 'created' });
}

process.stdout.write('\n');
for (const result of results) {
  if (result.address === null) {
    process.stdout.write(`  ${result.target}\n    ${result.note}\n`);
  } else {
    process.stdout.write(`  ${result.target}\n    ${result.address}   (${result.note})\n`);
  }
}
process.stdout.write('\n');

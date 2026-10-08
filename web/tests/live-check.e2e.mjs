// End-to-end test of the in-browser live check, in Chromium, against real devnet.
//
//   BASE_URL=http://localhost:3100 node tests/live-check.e2e.mjs
//
// A Wallet Standard test wallet is injected into the page. It signs with the
// repository's funded devnet key (read from ../.keys/payer.json, never sent
// anywhere), so the page sees exactly what it would see from a real wallet:
// discovery, connect, and signTransaction. Three scenarios are asserted:
//
//   1. The mechanism check passes end to end and returns the leftover SOL.
//   2. A faithful wallet passes the wallet test.
//   3. A wallet that rewrites the blockhash is caught BEFORE anything is sent,
//      and reported as a change to the transaction rather than a send failure.

import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3100';
const RPC = 'https://api.devnet.solana.com';

const secret = Uint8Array.from(
  JSON.parse(readFileSync(path.resolve('..', '.keys', 'payer.json'), 'utf8')),
);
const keypair = Keypair.fromSecretKey(secret);
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const privateKey = createPrivateKey({
  key: Buffer.concat([PKCS8_PREFIX, Buffer.from(secret.slice(0, 32))]),
  format: 'der',
  type: 'pkcs8',
});

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** Sign a legacy transaction's message as the fee payer (signature slot 0). */
function signAsWallet(txBytes, rewrite) {
  const bytes = Buffer.from(txBytes);
  const sigCount = bytes[0];
  const messageStart = 1 + 64 * sigCount;
  const message = Buffer.from(bytes.subarray(messageStart));

  // Durable-nonce payments in this page compile to exactly four account keys.
  const keyCount = message[3];
  if (rewrite && keyCount === 4) {
    const blockhashOffset = 3 + 1 + 32 * keyCount;
    randomBytes(32).copy(message, blockhashOffset);
  }

  const signature = sign(null, message, privateKey);
  signature.copy(bytes, 1);
  message.copy(bytes, messageStart);
  return Array.from(bytes);
}

const connection = new Connection(RPC, 'confirmed');
const before = await connection.getBalance(keypair.publicKey);
console.log(`test wallet ${keypair.publicKey.toBase58()}  ${(before / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
if (before < 0.03 * LAMPORTS_PER_SOL) {
  console.error('test wallet needs at least 0.03 devnet SOL');
  process.exit(2);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

await page.exposeFunction('__sign', (txBytes, rewrite) => signAsWallet(txBytes, rewrite));

await page.addInitScript(
  ({ address, publicKey }) => {
    const account = {
      address,
      publicKey: Uint8Array.from(publicKey),
      chains: ['solana:devnet'],
      features: ['solana:signTransaction'],
    };
    const wallet = {
      version: '1.0.0',
      name: 'Test Wallet',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiBmaWxsPSIjMGU2ZTRlIi8+PC9zdmc+',
      chains: ['solana:devnet'],
      accounts: [],
      features: {
        'standard:connect': {
          version: '1.0.0',
          connect: async () => {
            // Real wallets populate `accounts` on connect; the adapter reads it from there.
            wallet.accounts = [account];
            return { accounts: [account] };
          },
        },
        'standard:events': { version: '1.0.0', on: () => () => {} },
        'solana:signTransaction': {
          version: '1.0.0',
          supportedTransactionVersions: ['legacy'],
          signTransaction: async (...inputs) =>
            Promise.all(
              inputs.map(async (input) => ({
                signedTransaction: Uint8Array.from(
                  await window.__sign(Array.from(input.transaction), window.__rewrite === true),
                ),
              })),
            ),
        },
      },
    };
    const register = (api) => api.register(wallet);
    window.addEventListener('wallet-standard:app-ready', (event) => register(event.detail));
    window.dispatchEvent(
      new CustomEvent('wallet-standard:register-wallet', { bubbles: false, detail: register }),
    );
  },
  { address: keypair.publicKey.toBase58(), publicKey: Array.from(keypair.publicKey.toBytes()) },
);

await page.goto(BASE_URL, { waitUntil: 'networkidle' });

// --- connect ---------------------------------------------------------------
await page.getByRole('button', { name: /connect wallet/i }).first().click();
await page.getByText('Test Wallet', { exact: false }).first().click();
await page.getByTestId('live-check').scrollIntoViewIfNeeded();
try {
  await page.getByTestId('run-mechanism').waitFor({ timeout: 60_000 });
} catch (error) {
  console.log('--- live check text ---');
  console.log(await page.getByTestId('live-check').innerText());
  console.log('--- nav text ---');
  console.log(await page.locator('header').first().innerText());
  console.log('--- console errors ---');
  console.log(consoleErrors.join(' | '));
  await browser.close();
  throw error;
}
check(true, 'wallet discovered, connected, and the live check is ready');

// --- 1. the mechanism --------------------------------------------------------
await page.getByTestId('run-mechanism').click();
const mech = page.getByTestId('mechanism-verdict');
await mech.waitFor({ timeout: 240_000 });
check((await mech.getAttribute('data-pass')) === 'true', 'mechanism check passes end to end');
await page.getByText('Returned the leftover SOL to your wallet').waitFor({ timeout: 90_000 });
check(true, 'the throwaway key returned the leftover SOL');
const mechText = await page.getByTestId('live-check').innerText();
check(/Matches what was recorded/.test(mechText) && !/DIFFERENT/.test(mechText), 'confirmed message matches the hash recorded before sending');
check(/Rebroadcasts had no effect/.test(mechText), 'rebroadcasts changed nothing');

// --- 2. a faithful wallet -----------------------------------------------------
await page.getByTestId('run-wallet-test').click();
const gate = page.getByTestId('wallet-verdict');
await gate.waitFor({ timeout: 240_000 });
check((await gate.getAttribute('data-pass')) === 'true', 'faithful wallet: durable-nonce payment passes through unchanged');

// --- 3. a wallet that rewrites the blockhash ----------------------------------
await page.evaluate(() => {
  window.__rewrite = true;
});
await page.getByTestId('run-wallet-test').click();
await page.waitForFunction(
  () => document.querySelector('[data-testid="wallet-verdict"]')?.textContent?.includes('changed'),
  null,
  { timeout: 240_000 },
);
const rewritten = page.getByTestId('wallet-verdict');
check((await rewritten.getAttribute('data-pass')) === 'false', 'rewriting wallet: reported as a failure');
const rewrittenText = await rewritten.innerText();
check(/changed the transaction/.test(rewrittenText), 'rewriting wallet: reported as a change, caught before sending');
const gateText = await page.getByTestId('live-check').innerText();
check(/blockhash field .* became/.test(gateText), 'the report names the blockhash that changed');
check(!/Simulation failed|Blockhash not found/.test(gateText.split('Your wallet')[1] ?? ''), 'no confusing downstream send error');

// --- no console errors ---------------------------------------------------------
const real = consoleErrors.filter((text) => !/favicon|Failed to load resource.*(404|429)/i.test(text));
check(real.length === 0, 'no console errors', real.slice(0, 2).join(' | '));

await page.screenshot({ path: '../docs/screenshots/live-check-e2e.png', fullPage: false });
await browser.close();

const after = await new Connection(RPC, 'confirmed').getBalance(keypair.publicKey);
console.log(`test wallet spent ${((before - after) / LAMPORTS_PER_SOL).toFixed(6)} SOL (rent left in the gate-test slot accounts)`);
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

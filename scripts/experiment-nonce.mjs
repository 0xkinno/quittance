#!/usr/bin/env node
/**
 * Experiments E5, E6 and the rollback-then-advance confirmation, run against
 * real devnet.
 *
 * These are the experiments that do not need a wallet or a phone, so they can
 * settle the mechanism's core claims independently of MWA. They test what the
 * runtime does, which is the part of the thesis Quittance does not implement
 * and cannot get wrong:
 *
 *   E5  A durable nonce transaction produces a deterministic verdict from one
 *       account read, with no local signature knowledge.
 *
 *   E6  Rebroadcasting identical bytes after the nonce advanced is dropped by
 *       the runtime. This is invariant I1, and it is enforced by the
 *       validator rather than by us.
 *
 *   E-R "Nonce advanced" means processed, not paid. A transaction whose
 *       transfer instruction fails still advances the nonce, because the
 *       runtime rolls the accounts back and then stores the advanced value to
 *       prevent replay of a failed nonce transaction.
 *
 * Every result is written to `evidence/experiments.json` with the exact
 * signatures and account states observed, so each number in the README can be
 * traced to a transaction anyone can look up.
 *
 *   node scripts/experiment-nonce.mjs
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function env(key) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const text = line.trim();
    if (text.startsWith('#') || !text.includes('=')) continue;
    const at = text.indexOf('=');
    if (text.slice(0, at).trim() === key) return text.slice(at + 1).trim();
  }
  return null;
}

const RPC = env('HELIUS_RPC_URL');
if (RPC === null || RPC.length === 0) {
  process.stderr.write('HELIUS_RPC_URL is not set in .env\n');
  process.exit(2);
}

const connection = new Connection(RPC, 'finalized');
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(env('PAYER_KEYPAIR_PATH') ?? '.keys/payer.json', 'utf8'))),
);

const results = [];
const log = (...parts) => process.stdout.write(`${parts.join(' ')}\n`);

function record(id, title, claim, observed, passed, evidence) {
  results.push({ id, title, claim, observed, passed, evidence });
  log(`  ${passed ? 'PASS' : 'FAIL'}  ${id}  ${title}`);
  log(`        ${observed}`);
}

/** Read a nonce account's stored value, or null if it is not one. */
async function readNonce(pubkey) {
  const account = await connection.getAccountInfo(pubkey, 'finalized');
  if (account === null || account.data.length < NONCE_ACCOUNT_LENGTH) return null;
  return NonceAccount.fromAccountData(account.data).nonce;
}

// ---------------------------------------------------------------------------

async function main() {
  log('');
  log('  durable nonce mechanism — against devnet');
  log(`  rpc     ${new URL(RPC).host}`);
  log(`  payer   ${payer.publicKey.toBase58()}`);
  const balance = await connection.getBalance(payer.publicKey, 'finalized');
  log(`  balance ${balance / LAMPORTS_PER_SOL} SOL`);
  log('');

  // --- create a nonce account ---------------------------------------------

  const nonceAccount = Keypair.generate();
  const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);

  log(`  creating nonce account ${nonceAccount.publicKey.toBase58()}`);
  const createSignature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: nonceAccount.publicKey,
        lamports: rent,
        space: NONCE_ACCOUNT_LENGTH,
        programId: SystemProgram.programId,
      }),
      SystemProgram.nonceInitialize({
        noncePubkey: nonceAccount.publicKey,
        authorizedPubkey: payer.publicKey,
      }),
    ),
    [payer, nonceAccount],
    { commitment: 'finalized' },
  );
  log(`  created in ${createSignature}`);
  log('');

  const nonceBefore = await readNonce(nonceAccount.publicKey);

  // --- E5: a deterministic verdict from one account read -------------------
  //
  // Build a durable nonce transaction, send it, and confirm the whole question
  // "did it happen" is answerable by comparing one account's stored value to
  // the value the transaction was built against.

  const recipient = Keypair.generate();
  const transferLamports = 1_000_000;

  const durable = new Transaction();
  durable.add(
    SystemProgram.nonceAdvance({
      noncePubkey: nonceAccount.publicKey,
      authorizedPubkey: payer.publicKey,
    }),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient.publicKey,
      lamports: transferLamports,
    }),
  );
  durable.feePayer = payer.publicKey;
  // The substitution that is the whole mechanism: the nonce value occupies the
  // blockhash field, so this transaction never expires while the nonce holds.
  durable.recentBlockhash = nonceBefore;
  durable.sign(payer);

  const durableBytes = durable.serialize();

  const sentSignature = await connection.sendRawTransaction(durableBytes, {
    skipPreflight: false,
  });
  await connection.confirmTransaction(sentSignature, 'finalized');

  const nonceAfter = await readNonce(nonceAccount.publicKey);

  record(
    'E5',
    'one account read answers whether the payment happened',
    'If the stored nonce still equals the value the transaction was built against, it was never processed. If it has advanced, exactly one transaction consumed it.',
    `nonce moved from ${nonceBefore} to ${nonceAfter}`,
    nonceBefore !== nonceAfter && nonceAfter !== null,
    { noncePubkey: nonceAccount.publicKey.toBase58(), nonceBefore, nonceAfter, signature: sentSignature },
  );

  // The second half of E5: the nonce account is also the index. One pubkey,
  // no local signature knowledge, recovers which transaction did it.
  const signatures = await connection.getSignaturesForAddress(
    nonceAccount.publicKey,
    { limit: 10 },
    'finalized',
  );
  const foundBySearch = signatures.some((entry) => entry.signature === sentSignature);

  record(
    'E5b',
    'the nonce account is also the index',
    'getSignaturesForAddress on the nonce account returns exactly the transactions that touched it, so the consuming signature is recoverable from one pubkey.',
    `${signatures.length} signatures on the account; the sent transaction ${foundBySearch ? 'was' : 'was NOT'} among them`,
    foundBySearch,
    { signatures: signatures.map((entry) => entry.signature) },
  );

  // --- E6: rebroadcast, measured two ways ---------------------------------
  //
  // There are two distinct protections here and an earlier version of this
  // experiment conflated them, so both are now measured separately.
  //
  //   E6a  Identical bytes produce an identical signature, and the cluster
  //        deduplicates by signature: the resend is answered from the already
  //        confirmed transaction without being re-validated at all. So the
  //        RPC "accepting" a resend says nothing. What matters is how many
  //        times the effect occurred, and that is measured on the recipient's
  //        balance rather than on what the RPC returned.
  //
  //   E6b  The nonce protection proper. A *different* transaction built
  //        against the now-stale nonce value has a different signature, so
  //        dedup does not apply and the runtime has to validate it — and it
  //        rejects it, because the stored nonce no longer matches.
  //
  // E6b is the one that demonstrates invariant I1 is enforced by the
  // validator. E6a demonstrates that the naive retry is harmless in practice.

  log('');
  log('  E6a: rebroadcasting the identical bytes 10 times...');

  let accepted = 0;
  let rejected = 0;
  const rejectReasons = [];

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      // skipPreflight so the cluster, not the client, decides.
      //
      // Deliberately not confirmed per attempt. `confirmTransaction` opens a
      // websocket subscription, and ten of them in a loop leaked badly enough
      // to exhaust the heap. The measurement that matters is the destination
      // balance after the loop, which is read once below.
      await connection.sendRawTransaction(durableBytes, { skipPreflight: true });
      accepted += 1;
    } catch (error) {
      rejected += 1;
      const text = error instanceof Error ? error.message : String(error);
      rejectReasons.push(text.split(String.fromCharCode(10))[0].slice(0, 160));
    }
  }

  // One settling read, polled rather than subscribed.
  await new Promise((resolve) => setTimeout(resolve, 15_000));

  const recipientBalance = await connection.getBalance(recipient.publicKey, 'finalized');

  record(
    'E6a',
    'ten rebroadcasts, one effect',
    'A dumb retry loop cannot double-charge. Identical bytes carry an identical signature, so the cluster answers from the transaction it already has rather than processing a second one. The measurement that matters is the effect, not the RPC response.',
    `${accepted} of 10 resends answered by the cluster, ${rejected} refused; recipient holds ${recipientBalance} lamports against ${transferLamports} transferred once`,
    recipientBalance === transferLamports,
    {
      resendsAnswered: accepted,
      resendsRefused: rejected,
      recipientBalance,
      transferLamports,
      effects: recipientBalance / transferLamports,
      note: 'Identical bytes are deduplicated by signature before the nonce check is reached. E6b exercises the nonce check itself.',
    },
  );

  // --- E6b: a different transaction against the stale nonce ----------------

  log('');
  log('  E6b: a different transaction built against the now-stale nonce...');

  const stale = new Transaction();
  stale.add(
    SystemProgram.nonceAdvance({
      noncePubkey: nonceAccount.publicKey,
      authorizedPubkey: payer.publicKey,
    }),
    // A different amount, so this is a genuinely different transaction with a
    // different signature. Dedup cannot apply; the runtime must validate it.
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient.publicKey,
      lamports: transferLamports + 1,
    }),
  );
  stale.feePayer = payer.publicKey;
  // The nonce value this was built against has already been consumed.
  stale.recentBlockhash = nonceBefore;
  stale.sign(payer);

  // Not simulated through `connection.simulateTransaction`: given a
  // `Transaction` it re-populates the message and substitutes a *fresh*
  // blockhash, which quietly repairs the very staleness being tested and
  // reports success. An earlier version of this experiment did exactly that
  // and recorded a passing simulation against a transaction the cluster then
  // refused.
  //
  // Sent with preflight instead, so the cluster validates the bytes as they
  // are and returns its own reason.
  let staleAccepted = false;
  let staleError = '';
  let staleLogs = [];
  try {
    await connection.sendRawTransaction(stale.serialize(), { skipPreflight: false });
    staleAccepted = true;
  } catch (error) {
    // The whole message, not its first line: web3.js puts "Simulation failed."
    // on line one and the actual cause underneath.
    staleError = error instanceof Error ? error.message : String(error);
    if (typeof error?.getLogs === 'function') {
      try {
        staleLogs = (await error.getLogs(connection)) ?? [];
      } catch {
        staleLogs = error.logs ?? [];
      }
    } else {
      staleLogs = error?.logs ?? [];
    }
  }

  // The runtime's name for a nonce that has already been consumed. The nonce
  // check rejects before execution, so this is `BlockhashNotFound` rather than
  // an instruction error.
  const refusedForNonce = /BlockhashNotFound|Blockhash not found|blockhash not found/i.test(
    `${staleError} ${staleLogs.join(' ')}`,
  );

  const balanceAfterStale = await connection.getBalance(recipient.publicKey, 'finalized');

  record(
    'E6b',
    'the runtime rejects a transaction whose nonce has been consumed',
    'This is invariant I1, and it is enforced by the validator rather than by Quittance. A nonce transaction validates only while the stored value equals the value in its blockhash field, and processing advances that value before execution.',
    staleAccepted
      ? `the stale transaction was ACCEPTED; recipient now holds ${balanceAfterStale}`
      : `refused${refusedForNonce ? ' for the nonce' : ''} — ${staleError.replace(/\s+/g, ' ').slice(0, 150)}; recipient still holds ${balanceAfterStale}`,
    !staleAccepted && balanceAfterStale === transferLamports && refusedForNonce,
    {
      accepted: staleAccepted,
      // The validator's own words. `BlockhashNotFound` is the nonce check
      // refusing an already-consumed nonce, which is exactly citation C2.
      refusedForNonce,
      sendError: staleError.replace(/\s+/g, ' ').slice(0, 400),
      logs: staleLogs.slice(0, 6),
      recipientBalance: balanceAfterStale,
      expectedBalance: transferLamports,
    },
  );

  // --- E-R: advanced means processed, not paid -----------------------------
  //
  // The nuance the whole verdict machine is built around. A nonce transaction
  // whose transfer fails still advances the nonce, so a design that reads the
  // nonce as a paid/not-paid boolean credits failed transfers.

  log('');
  log('  sending a durable nonce transaction whose transfer must fail...');

  const nonceBeforeFailure = await readNonce(nonceAccount.publicKey);

  const failing = new Transaction();
  failing.add(
    SystemProgram.nonceAdvance({
      noncePubkey: nonceAccount.publicKey,
      authorizedPubkey: payer.publicKey,
    }),
    // Deliberately unpayable: more lamports than the payer holds.
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient.publicKey,
      lamports: 100_000 * LAMPORTS_PER_SOL,
    }),
  );
  failing.feePayer = payer.publicKey;
  failing.recentBlockhash = nonceBeforeFailure;
  failing.sign(payer);

  let failingSignature = null;
  let failingError = null;
  try {
    failingSignature = await connection.sendRawTransaction(failing.serialize(), {
      skipPreflight: true,
    });
    // Polled rather than subscribed, for the same reason as above.
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const status = await connection.getSignatureStatus(failingSignature, {
        searchTransactionHistory: true,
      });
      if (status.value?.confirmationStatus === 'finalized' || status.value?.err != null) {
        failingError = status.value?.err ?? 'finalized with no error';
        break;
      }
    }
  } catch (error) {
    failingError = error instanceof Error ? error.message : String(error);
  }

  const nonceAfterFailure = await readNonce(nonceAccount.publicKey);
  const balanceAfterFailure = await connection.getBalance(recipient.publicKey, 'finalized');

  record(
    'E-R',
    'a failed transfer still advances the nonce',
    'The runtime rolls the accounts back and then stores the advanced nonce anyway, to stop replay of a failed nonce transaction. So "advanced" means processed, not paid, and there are three terminal on-chain outcomes rather than two.',
    `nonce moved from ${nonceBeforeFailure} to ${nonceAfterFailure} while the transfer failed and the recipient balance stayed at ${balanceAfterFailure}`,
    nonceBeforeFailure !== nonceAfterFailure &&
      failingError !== null &&
      balanceAfterFailure === transferLamports,
    {
      nonceBeforeFailure,
      nonceAfterFailure,
      signature: failingSignature,
      error: typeof failingError === 'string' ? failingError : JSON.stringify(failingError),
      recipientBalance: balanceAfterFailure,
    },
  );

  // --- reclaim -------------------------------------------------------------

  log('');
  log('  closing the nonce account to reclaim its rent...');
  try {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.nonceWithdraw({
          noncePubkey: nonceAccount.publicKey,
          authorizedPubkey: payer.publicKey,
          toPubkey: payer.publicKey,
          lamports: rent,
        }),
      ),
      [payer],
      { commitment: 'finalized' },
    );
    log('  reclaimed');
  } catch (error) {
    log(`  could not reclaim: ${error instanceof Error ? error.message : String(error)}`);
  }

  // --- write the evidence --------------------------------------------------

  mkdirSync('evidence', { recursive: true });
  const file = {
    generatedAtIso: new Date().toISOString(),
    rpcHost: new URL(RPC).host,
    cluster: env('SOLANA_CLUSTER'),
    payer: payer.publicKey.toBase58(),
    nonceAccount: nonceAccount.publicKey.toBase58(),
    createSignature,
    results,
    allPassed: results.every((result) => result.passed),
  };
  writeFileSync('evidence/experiments.json', `${JSON.stringify(file, null, 2)}\n`, 'utf8');

  log('');
  log(`  ${results.filter((r) => r.passed).length} of ${results.length} passed`);
  log('  written to evidence/experiments.json');
  log('');

  process.exitCode = file.allPassed ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 2;
});

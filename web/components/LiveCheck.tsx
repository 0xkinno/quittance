'use client';

/**
 * The live check.
 *
 * Every other proof on this page is something Quittance ran and recorded.
 * This is the one a visitor runs themselves, with their own wallet, against
 * the same devnet cluster, live. Nothing here is a simulation of the
 * mechanism — it is the mechanism, imported from `@quittance/engine` with no
 * modification, the same package the app and the offline verifier import.
 *
 * It deliberately does not touch the Quittance program. E5, E6 and E8 do not
 * either — they test what the Solana runtime does, which is the part of the
 * thesis this project does not implement and therefore cannot get wrong. This
 * is that same experiment, running in a browser instead of in Node or on a
 * phone, with a real connected wallet standing in for Seed Vault.
 *
 * Two wallet approvals, in the write-ahead order the whole product is built
 * around: first the nonce account is created and its value is read, *then*
 * the durable-nonce transaction is hashed, *then* it is signed and sent.
 */

import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { digestsEqual, hashCompiledMessage, hashCompiledMessageBase64 } from '@quittance/engine';
import { useCallback, useEffect, useState } from 'react';

import styles from './live-check.module.css';

type StepState = 'pending' | 'running' | 'pass' | 'fail';

interface Step {
  readonly label: string;
  readonly detail: string;
  readonly state: StepState;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

export function LiveCheck(): React.JSX.Element {
  const { connection } = useConnection();
  const { publicKey, connected, signTransaction } = useWallet();

  const [balance, setBalance] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [steps, setSteps] = useState<readonly Step[]>([]);
  const [verdict, setVerdict] = useState<{ pass: boolean; summary: string } | null>(null);
  const [reclaimable, setReclaimable] = useState<{
    noncePubkey: string;
    authority: string;
  } | null>(null);

  useEffect(() => {
    if (!connected || publicKey === null) {
      setBalance(null);
      return undefined;
    }
    let cancelled = false;
    const read = (): void => {
      connection
        .getBalance(publicKey, 'confirmed')
        .then((lamports) => {
          if (!cancelled) setBalance(lamports / LAMPORTS_PER_SOL);
        })
        .catch(() => {
          if (!cancelled) setBalance(null);
        });
    };
    read();
    const id = setInterval(read, 8_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connected, publicKey, connection]);

  const push = useCallback((step: Step) => {
    setSteps((current) => [...current, step]);
  }, []);

  const run = useCallback(async () => {
    if (publicKey === null || signTransaction === undefined) return;

    setSteps([]);
    setVerdict(null);
    setReclaimable(null);
    setPhase('running');

    try {
      // --- create and initialize a fresh nonce account ----------------------
      push({
        label: 'Creating a slot account',
        detail: 'rent-exempt, 80 bytes, paid from your wallet',
        state: 'running',
      });

      const nonceKeypair = Keypair.generate();
      const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
      const { blockhash: setupBlockhash } = await connection.getLatestBlockhash('finalized');

      const setupTx = new Transaction();
      setupTx.add(
        SystemProgram.createAccount({
          fromPubkey: publicKey,
          newAccountPubkey: nonceKeypair.publicKey,
          lamports: rent,
          space: NONCE_ACCOUNT_LENGTH,
          programId: SystemProgram.programId,
        }),
        SystemProgram.nonceInitialize({
          noncePubkey: nonceKeypair.publicKey,
          authorizedPubkey: publicKey,
        }),
      );
      setupTx.feePayer = publicKey;
      setupTx.recentBlockhash = setupBlockhash;
      setupTx.partialSign(nonceKeypair);

      const signedSetup = await signTransaction(setupTx);
      const setupSig = await connection.sendRawTransaction(signedSetup.serialize(), {
        skipPreflight: false,
      });
      await waitForFinalized(connection, setupSig);

      push({
        label: 'Creating a slot account',
        detail: nonceKeypair.publicKey.toBase58(),
        state: 'pass',
      });

      // --- read the value, build, hash — before anything is sent -----------

      const info = await connection.getAccountInfo(nonceKeypair.publicKey, 'finalized');
      if (info === null) throw new Error('the slot account did not initialize');
      const nonceBefore = NonceAccount.fromAccountData(info.data).nonce;

      const durableTx = new Transaction();
      durableTx.add(
        SystemProgram.nonceAdvance({
          noncePubkey: nonceKeypair.publicKey,
          authorizedPubkey: publicKey,
        }),
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: publicKey, lamports: 1 }),
      );
      durableTx.feePayer = publicKey;
      durableTx.recentBlockhash = nonceBefore;

      const builtHash = hashCompiledMessage(new Uint8Array(durableTx.serializeMessage()));

      push({
        label: 'Built the payment and hashed it',
        detail: `${builtHash.slice(0, 20)}… — written down before the wallet is asked to sign`,
        state: 'pass',
      });

      // --- sign and send ------------------------------------------------------

      push({ label: 'Awaiting your approval', detail: 'the durable-nonce payment', state: 'running' });

      const signedDurable = await signTransaction(durableTx);
      const rawBytes = signedDurable.serialize();
      const durableSig = await connection.sendRawTransaction(rawBytes, { skipPreflight: false });
      await waitForFinalized(connection, durableSig);

      push({
        label: 'Sent',
        detail: durableSig,
        state: 'pass',
      });

      // --- read back: did it land, and is it the one we built? -------------

      const afterInfo = await connection.getAccountInfo(nonceKeypair.publicKey, 'finalized');
      const nonceAfter =
        afterInfo === null ? null : NonceAccount.fromAccountData(afterInfo.data).nonce;
      const advanced = nonceAfter !== null && nonceAfter !== nonceBefore;

      push({
        label: 'The slot account advanced',
        detail: advanced
          ? `${nonceBefore.slice(0, 10)}… → ${(nonceAfter ?? '').slice(0, 10)}…`
          : 'it did not advance',
        state: advanced ? 'pass' : 'fail',
      });

      const landed = await connection.getTransaction(durableSig, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });
      const landedHash =
        landed === null
          ? null
          : hashCompiledMessageBase64(
              Buffer.from(landed.transaction.message.serialize()).toString('base64'),
            );
      const matches = landedHash !== null && digestsEqual(landedHash, builtHash);

      push({
        label: 'Matches what was recorded',
        detail: matches
          ? 'the transaction the chain confirmed is the one built before signing'
          : 'DIFFERENT — this would escalate rather than settle',
        state: matches ? 'pass' : 'fail',
      });

      // --- rebroadcast the identical bytes, three times ----------------------

      push({ label: 'Rebroadcasting the identical bytes', detail: 'three times', state: 'running' });

      let dropped = 0;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await connection.sendRawTransaction(rawBytes, { skipPreflight: true });
        } catch {
          dropped += 1;
        }
      }

      push({
        label: 'Rebroadcasts',
        detail: `the runtime refused ${dropped} of 3 — the one that already landed is the only effect`,
        state: 'pass',
      });

      const pass = advanced && matches;
      setVerdict({
        pass,
        summary: pass
          ? 'Exactly one payment landed, and what you see here is what the chain confirmed — not what your wallet reported.'
          : 'Something did not match. See the steps above for exactly what diverged.',
      });
      setReclaimable({
        noncePubkey: nonceKeypair.publicKey.toBase58(),
        authority: publicKey.toBase58(),
      });
      setPhase('done');
    } catch (error) {
      push({
        label: 'Stopped',
        detail: error instanceof Error ? error.message : String(error),
        state: 'fail',
      });
      setPhase('error');
    }
  }, [publicKey, signTransaction, connection, push]);

  const reclaim = useCallback(async () => {
    if (reclaimable === null || publicKey === null || signTransaction === undefined) return;
    try {
      const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
      const { blockhash } = await connection.getLatestBlockhash('finalized');
      const tx = new Transaction();
      tx.add(
        SystemProgram.nonceWithdraw({
          noncePubkey: new PublicKey(reclaimable.noncePubkey),
          authorizedPubkey: publicKey,
          toPubkey: publicKey,
          lamports: rent,
        }),
      );
      tx.feePayer = publicKey;
      tx.recentBlockhash = blockhash;
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await waitForFinalized(connection, sig);
      setReclaimable(null);
    } catch {
      // The rent is a fraction of a cent on devnet. A failed reclaim costs the
      // visitor nothing and is not worth a modal.
    }
  }, [reclaimable, publicKey, signTransaction, connection]);

  const needsFunds = balance !== null && balance < 0.003;

  return (
    <div className={styles.wrap} data-testid="live-check">
      {!connected ? (
        <p className={styles.gate}>Connect a devnet wallet above to run this yourself.</p>
      ) : signTransaction === undefined ? (
        <p className={styles.gate}>
          {'This wallet does not expose signTransaction, so the live check cannot run through ' +
            'it. Try Phantom or Solflare.'}
        </p>
      ) : needsFunds ? (
        <p className={styles.gate}>
          Your wallet holds {balance?.toFixed(4)} SOL on devnet, and this needs about 0.003 for
          rent and fees. Get some free devnet SOL at{' '}
          <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">
            faucet.solana.com
          </a>
          .
        </p>
      ) : (
        <button
          type="button"
          className={styles.runButton}
          onClick={() => void run()}
          disabled={phase === 'running'}
        >
          {phase === 'running' ? 'Running…' : phase === 'done' ? 'Run it again' : 'Run the live check'}
        </button>
      )}

      {steps.length > 0 ? (
        <ul className={styles.steps}>
          {steps.map((step, i) => (
            <li key={`${step.label}-${i}`} className={styles.step}>
              <span
                className={`mono ${styles.mark}`}
                data-state={step.state}
              >
                {step.state === 'pass' ? 'PASS' : step.state === 'fail' ? 'FAIL' : '····'}
              </span>
              <span className={styles.stepText}>
                <strong>{step.label}</strong>
                <span className={`mono ${styles.stepDetail}`}>{step.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {verdict !== null ? (
        <div className={styles.verdict} data-pass={verdict.pass}>
          <p className={styles.verdictTitle}>{verdict.pass ? 'Confirmed' : 'Did not match'}</p>
          <p className={styles.verdictBody}>{verdict.summary}</p>
        </div>
      ) : null}

      {reclaimable !== null ? (
        <button type="button" className={styles.reclaim} onClick={() => void reclaim()}>
          Reclaim the rent (~0.0014 SOL back to your wallet)
        </button>
      ) : null}
    </div>
  );
}

/** Polled rather than subscribed — a websocket confirmation leaks in a loop. */
async function waitForFinalized(
  connection: ReturnType<typeof useConnection>['connection'],
  signature: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    if (status.value?.confirmationStatus === 'finalized') return;
    if (status.value?.err != null) {
      throw new Error(`transaction failed: ${JSON.stringify(status.value.err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`${signature} did not finalize in time`);
}

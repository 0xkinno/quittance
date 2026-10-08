'use client';

/**
 * The live check.
 *
 * Every other proof on this page is something Quittance ran and recorded.
 * This is the one a visitor runs themselves, against the same devnet cluster,
 * live. Nothing here simulates the mechanism: it is the mechanism, with the
 * hashing and comparison imported from `@quittance/engine` unmodified — the
 * same package the app and the offline verifier import.
 *
 * Two independent checks, kept apart on purpose:
 *
 * 1. **The mechanism.** What the Solana runtime does with a durable-nonce
 *    payment: the value is read, the payment is built and hashed *before*
 *    anything is sent, the chain's confirmed message is compared with that
 *    hash, and the identical bytes are rebroadcast. The visitor's wallet only
 *    funds a throwaway key with an ordinary transfer; the throwaway key signs
 *    the durable payment inside the tab. This isolates what the chain does
 *    from what any particular wallet does, and returns the leftover SOL.
 *
 * 2. **The wallet.** Whether the visitor's wallet hands a durable-nonce
 *    transaction back unchanged. It is a separate, optional test, and it
 *    compares what the wallet returns with what was built before sending, so a
 *    wallet that alters or refuses it is reported precisely rather than failing
 *    somewhere downstream.
 *
 * Neither touches the Quittance program. E5 and E6 do not either — they test
 * what the runtime does, the part of the thesis this project does not
 * implement and therefore cannot get wrong.
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

interface Verdict {
  readonly pass: boolean;
  readonly title: string;
  readonly summary: string;
}

type Conn = ReturnType<typeof useConnection>['connection'];

/** Enough for the slot account's rent, a few fees, and the return transfer. */
const FUNDING_LAMPORTS = 3_000_000;
const FEE_LAMPORTS = 5_000;

export function LiveCheck(): React.JSX.Element {
  const { connection } = useConnection();
  const { publicKey, connected, signTransaction } = useWallet();

  const [balance, setBalance] = useState<number | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [steps, setSteps] = useState<readonly Step[]>([]);
  const [verdict, setVerdict] = useState<Verdict | null>(null);

  const [gatePhase, setGatePhase] = useState<Phase>('idle');
  const [gateSteps, setGateSteps] = useState<readonly Step[]>([]);
  const [gateVerdict, setGateVerdict] = useState<Verdict | null>(null);
  const [reclaimable, setReclaimable] = useState<string | null>(null);

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
  const pushGate = useCallback((step: Step) => {
    setGateSteps((current) => [...current, step]);
  }, []);

  // ---------------------------------------------------------------------------
  // 1. The mechanism
  // ---------------------------------------------------------------------------

  const runMechanism = useCallback(async () => {
    if (publicKey === null || signTransaction === undefined) return;

    setSteps([]);
    setVerdict(null);
    setPhase('running');

    const session = Keypair.generate();
    let returnNonce: PublicKey | null = null;
    let funded = false;

    try {
      // The wallet's only job: an ordinary transfer to fund a throwaway key.
      push({
        label: 'Funding a throwaway key',
        detail: `${FUNDING_LAMPORTS / LAMPORTS_PER_SOL} SOL from your wallet, held only in this tab and returned at the end`,
        state: 'running',
      });
      const { blockhash: fundBlockhash } = await connection.getLatestBlockhash('finalized');
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: session.publicKey,
          lamports: FUNDING_LAMPORTS,
        }),
      );
      fundTx.feePayer = publicKey;
      fundTx.recentBlockhash = fundBlockhash;
      const signedFund = await signTransaction(fundTx);
      const fundSig = await connection.sendRawTransaction(signedFund.serialize());
      funded = true;
      await waitForFinalized(connection, fundSig);
      push({ label: 'Funding a throwaway key', detail: session.publicKey.toBase58(), state: 'pass' });

      // Create the slot (nonce) account, signed inside the tab.
      push({ label: 'Creating a slot account', detail: 'rent-exempt, 80 bytes', state: 'running' });
      const nonceKeypair = Keypair.generate();
      const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
      const { blockhash: setupBlockhash } = await connection.getLatestBlockhash('finalized');
      const setupTx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: session.publicKey,
          newAccountPubkey: nonceKeypair.publicKey,
          lamports: rent,
          space: NONCE_ACCOUNT_LENGTH,
          programId: SystemProgram.programId,
        }),
        SystemProgram.nonceInitialize({
          noncePubkey: nonceKeypair.publicKey,
          authorizedPubkey: session.publicKey,
        }),
      );
      setupTx.feePayer = session.publicKey;
      setupTx.recentBlockhash = setupBlockhash;
      setupTx.sign(session, nonceKeypair);
      const setupSig = await connection.sendRawTransaction(setupTx.serialize());
      await waitForFinalized(connection, setupSig);
      returnNonce = nonceKeypair.publicKey;
      push({
        label: 'Creating a slot account',
        detail: nonceKeypair.publicKey.toBase58(),
        state: 'pass',
      });

      // Read the value, build, hash — before anything is sent.
      const nonceBefore = await readNonce(connection, nonceKeypair.publicKey);
      if (nonceBefore === null) throw new Error('the slot account did not initialize');

      const durableTx = new Transaction().add(
        SystemProgram.nonceAdvance({
          noncePubkey: nonceKeypair.publicKey,
          authorizedPubkey: session.publicKey,
        }),
        SystemProgram.transfer({
          fromPubkey: session.publicKey,
          toPubkey: session.publicKey,
          lamports: 1,
        }),
      );
      durableTx.feePayer = session.publicKey;
      durableTx.recentBlockhash = nonceBefore;
      const builtHash = hashCompiledMessage(new Uint8Array(durableTx.serializeMessage()));
      push({
        label: 'Built the payment and hashed it',
        detail: `${builtHash.slice(0, 20)}… — written down before anything is sent`,
        state: 'pass',
      });

      // Sign and send.
      durableTx.sign(session);
      const rawBytes = durableTx.serialize();
      const durableSig = await connection.sendRawTransaction(rawBytes);
      await waitForFinalized(connection, durableSig);
      push({ label: 'Sent', detail: durableSig, state: 'pass' });

      // Read back: did it land, and is it the one we built?
      const nonceAfter = await readNonce(connection, nonceKeypair.publicKey);
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
              bytesToBase64(new Uint8Array(landed.transaction.message.serialize())),
            );
      const matches = landedHash !== null && digestsEqual(landedHash, builtHash);
      push({
        label: 'Matches what was recorded',
        detail: matches
          ? 'the transaction the chain confirmed is the one built before sending'
          : 'DIFFERENT — this would escalate rather than settle',
        state: matches ? 'pass' : 'fail',
      });

      // Rebroadcast the identical bytes, three times; the effect is the balance.
      push({
        label: 'Rebroadcasting the identical bytes',
        detail: 'three times — then checking the balance',
        state: 'running',
      });
      const balanceBefore = await connection.getBalance(session.publicKey, 'confirmed');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await connection.sendRawTransaction(rawBytes, { skipPreflight: true });
        } catch {
          // A refusal is as good as an acceptance: the effect is measured below.
        }
      }
      await sleep(6_000);
      const balanceAfter = await connection.getBalance(session.publicKey, 'confirmed');
      const once = balanceAfter === balanceBefore;
      push({
        label: 'Rebroadcasts had no effect',
        detail: once
          ? `balance unchanged at ${balanceAfter} lamports — the fee was charged once, not four times`
          : `balance moved ${balanceBefore} → ${balanceAfter}`,
        state: once ? 'pass' : 'fail',
      });

      const pass = advanced && matches && once;
      setVerdict({
        pass,
        title: pass ? 'Confirmed' : 'Did not match',
        summary: pass
          ? 'Exactly one payment landed, the chain confirmed the message that was built before sending, and replaying it changed nothing — read from the cluster, not reported by a wallet.'
          : 'Something did not match. See the steps above for exactly what diverged.',
      });
      setPhase('done');
    } catch (error) {
      push({
        label: 'Stopped',
        detail: error instanceof Error ? error.message : String(error),
        state: 'fail',
      });
      setPhase('error');
    } finally {
      // Give the visitor their SOL back: close the slot account into the
      // throwaway key, then sweep the key into the wallet. Best effort.
      if (funded) {
        await returnFunds({
          connection,
          session,
          nonce: returnNonce,
          to: publicKey,
          onDone: (lamports) =>
            push({
              label: 'Returned the leftover SOL to your wallet',
              detail: `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
              state: 'pass',
            }),
        });
      }
    }
  }, [publicKey, signTransaction, connection, push]);

  // ---------------------------------------------------------------------------
  // 2. The wallet
  // ---------------------------------------------------------------------------

  const runWalletTest = useCallback(async () => {
    if (publicKey === null || signTransaction === undefined) return;

    setGateSteps([]);
    setGateVerdict(null);
    setReclaimable(null);
    setGatePhase('running');

    try {
      pushGate({
        label: 'Creating a slot account',
        detail: 'owned by your wallet — approval 1 of 2',
        state: 'running',
      });
      const nonceKeypair = Keypair.generate();
      const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
      const { blockhash: setupBlockhash } = await connection.getLatestBlockhash('finalized');
      const setupTx = new Transaction().add(
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
      const setupSig = await connection.sendRawTransaction(signedSetup.serialize());
      await waitForFinalized(connection, setupSig);
      setReclaimable(nonceKeypair.publicKey.toBase58());
      pushGate({
        label: 'Creating a slot account',
        detail: nonceKeypair.publicKey.toBase58(),
        state: 'pass',
      });

      const nonceBefore = await readNonce(connection, nonceKeypair.publicKey);
      if (nonceBefore === null) throw new Error('the slot account did not initialize');

      const durableTx = new Transaction().add(
        SystemProgram.nonceAdvance({
          noncePubkey: nonceKeypair.publicKey,
          authorizedPubkey: publicKey,
        }),
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: publicKey, lamports: 1 }),
      );
      durableTx.feePayer = publicKey;
      durableTx.recentBlockhash = nonceBefore;
      const builtHash = hashCompiledMessage(new Uint8Array(durableTx.serializeMessage()));
      pushGate({
        label: 'Built the payment and hashed it',
        detail: `${builtHash.slice(0, 20)}… — nonce ${nonceBefore.slice(0, 12)}…`,
        state: 'pass',
      });

      pushGate({
        label: 'Asking your wallet to sign it',
        detail: 'approval 2 of 2 — the durable-nonce payment',
        state: 'running',
      });
      const signedDurable = await signTransaction(durableTx);

      // The decisive comparison, made BEFORE anything is sent: is the message
      // the wallet returned the message that was built?
      const returnedHash = hashCompiledMessage(new Uint8Array(signedDurable.serializeMessage()));
      const unchanged = digestsEqual(returnedHash, builtHash);

      if (!unchanged) {
        const returned = signedDurable.recentBlockhash ?? '(none)';
        pushGate({
          label: 'What your wallet returned',
          detail: `DIFFERENT — blockhash field ${nonceBefore.slice(0, 12)}… became ${returned.slice(0, 12)}…`,
          state: 'fail',
        });
        setGateVerdict({
          pass: false,
          title: 'Your wallet changed the transaction',
          summary:
            'It did not hand the durable-nonce payment back unchanged, so it was not sent. This is a property of the wallet, not of the mechanism: the check above runs the same payment end to end with a key held in this tab.',
        });
        setGatePhase('done');
        return;
      }

      pushGate({
        label: 'What your wallet returned',
        detail: 'identical to what was built — the nonce value survived',
        state: 'pass',
      });

      const sig = await connection.sendRawTransaction(signedDurable.serialize());
      await waitForFinalized(connection, sig);
      const nonceAfter = await readNonce(connection, nonceKeypair.publicKey);
      const advanced = nonceAfter !== null && nonceAfter !== nonceBefore;
      pushGate({
        label: 'Sent, and the slot account advanced',
        detail: sig,
        state: advanced ? 'pass' : 'fail',
      });
      setGateVerdict({
        pass: advanced,
        title: advanced ? 'Your wallet passes durable nonces through' : 'Did not advance',
        summary: advanced
          ? 'The message your wallet signed is the message that was built, and the chain confirmed it.'
          : 'The payment was sent but the slot account did not advance.',
      });
      setGatePhase('done');
    } catch (error) {
      pushGate({
        label: 'Stopped',
        detail: error instanceof Error ? error.message : String(error),
        state: 'fail',
      });
      setGatePhase('error');
    }
  }, [publicKey, signTransaction, connection, pushGate]);

  const reclaim = useCallback(async () => {
    if (reclaimable === null || publicKey === null || signTransaction === undefined) return;
    try {
      const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
      const { blockhash } = await connection.getLatestBlockhash('finalized');
      const tx = new Transaction().add(
        SystemProgram.nonceWithdraw({
          noncePubkey: new PublicKey(reclaimable),
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
      // A fraction of a cent on devnet; not worth a modal.
    }
  }, [reclaimable, publicKey, signTransaction, connection]);

  const needsFunds = balance !== null && balance < 0.005;
  const busy = phase === 'running' || gatePhase === 'running';
  const ready = connected && signTransaction !== undefined && !needsFunds;

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
          Your wallet holds {balance?.toFixed(4)} SOL on devnet, and this needs about 0.005 for
          rent and fees. Get some free devnet SOL at{' '}
          <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">
            faucet.solana.com
          </a>
          .
        </p>
      ) : null}

      {ready ? (
        <>
          <h3 className={styles.groupTitle}>1 · The mechanism</h3>
          <p className={styles.groupNote}>
            Your wallet approves one ordinary transfer to fund a throwaway key held in this tab.
            That key creates the slot account and signs the durable-nonce payment, so what you
            see is what the chain does — and the leftover SOL comes back to you.
          </p>
          <button
            type="button"
            className={styles.runButton}
            data-testid="run-mechanism"
            onClick={() => void runMechanism()}
            disabled={busy}
          >
            {phase === 'running'
              ? 'Running…'
              : phase === 'done'
                ? 'Run it again'
                : 'Run the mechanism check'}
          </button>
        </>
      ) : null}

      <StepList steps={steps} />
      <VerdictBox verdict={verdict} testId="mechanism-verdict" />

      {ready ? (
        <>
          <h3 className={styles.groupTitle}>2 · Your wallet</h3>
          <p className={styles.groupNote}>
            Optional. Asks your wallet to sign the durable-nonce payment itself and compares what
            it hands back with what was built, before anything is sent. Some wallets alter or
            refuse these transactions; this tells you which yours does.
          </p>
          <button
            type="button"
            className={styles.runButtonSecondary}
            data-testid="run-wallet-test"
            onClick={() => void runWalletTest()}
            disabled={busy}
          >
            {gatePhase === 'running' ? 'Running…' : 'Test my wallet'}
          </button>
        </>
      ) : null}

      <StepList steps={gateSteps} />
      <VerdictBox verdict={gateVerdict} testId="wallet-verdict" />

      {reclaimable !== null ? (
        <button type="button" className={styles.reclaim} onClick={() => void reclaim()}>
          Reclaim the rent (~0.0014 SOL back to your wallet)
        </button>
      ) : null}
    </div>
  );
}

function StepList({ steps }: { readonly steps: readonly Step[] }): React.JSX.Element | null {
  if (steps.length === 0) return null;
  return (
    <ul className={styles.steps}>
      {steps.map((step, i) => (
        <li key={`${step.label}-${i}`} className={styles.step}>
          <span className={`mono ${styles.mark}`} data-state={step.state}>
            {step.state === 'pass' ? 'PASS' : step.state === 'fail' ? 'FAIL' : '····'}
          </span>
          <span className={styles.stepText}>
            <strong>{step.label}</strong>
            <span className={`mono ${styles.stepDetail}`}>{step.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function VerdictBox({
  verdict,
  testId,
}: {
  readonly verdict: Verdict | null;
  readonly testId: string;
}): React.JSX.Element | null {
  if (verdict === null) return null;
  return (
    <div className={styles.verdict} data-pass={verdict.pass} data-testid={testId}>
      <p className={styles.verdictTitle}>{verdict.title}</p>
      <p className={styles.verdictBody}>{verdict.summary}</p>
    </div>
  );
}

async function readNonce(connection: Conn, pubkey: PublicKey): Promise<string | null> {
  const info = await connection.getAccountInfo(pubkey, 'finalized');
  if (info === null || info.data.length < NONCE_ACCOUNT_LENGTH) return null;
  return NonceAccount.fromAccountData(info.data).nonce;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

/** Close the slot account into the throwaway key, then sweep the key to the wallet. */
async function returnFunds(args: {
  readonly connection: Conn;
  readonly session: Keypair;
  readonly nonce: PublicKey | null;
  readonly to: PublicKey | null;
  readonly onDone: (lamports: number) => void;
}): Promise<void> {
  const { connection, session, nonce, to } = args;
  if (to === null) return;
  try {
    const balance = await connection.getBalance(session.publicKey, 'confirmed');
    if (balance < 2 * FEE_LAMPORTS) return;
    const tx = new Transaction();
    let sweep = balance - FEE_LAMPORTS;
    if (nonce !== null) {
      const info = await connection.getAccountInfo(nonce, 'confirmed');
      if (info !== null && info.lamports > 0) {
        tx.add(
          SystemProgram.nonceWithdraw({
            noncePubkey: nonce,
            authorizedPubkey: session.publicKey,
            toPubkey: session.publicKey,
            lamports: info.lamports,
          }),
        );
        sweep += info.lamports;
      }
    }
    tx.add(SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: to, lamports: sweep }));
    const { blockhash } = await connection.getLatestBlockhash('finalized');
    tx.feePayer = session.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(session);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await waitForFinalized(connection, sig);
    args.onDone(sweep);
  } catch {
    // Best effort: devnet SOL, a fraction of a cent.
  }
}

/** Polled rather than subscribed — a websocket confirmation leaks in a loop. */
async function waitForFinalized(connection: Conn, signature: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    if (status.value?.confirmationStatus === 'finalized') return;
    if (status.value?.err != null) {
      throw new Error(`transaction failed: ${JSON.stringify(status.value.err)}`);
    }
    await sleep(1_500);
  }
  throw new Error(`${signature} did not finalize in time`);
}

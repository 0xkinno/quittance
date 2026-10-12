/**
 * Experiment E8 — the thesis gate.
 *
 * **The question:** when a durable nonce transaction is handed to a wallet
 * through `signAndSendTransactions`, does the wallet broadcast the message it
 * was given, or does it substitute a recent blockhash for the nonce value?
 *
 * Everything in Quittance rests on the answer being "it broadcasts what it was
 * given". If a wallet rewrites the message, then the nonce the app recorded is
 * not the nonce the chain saw, the recorded message hash matches nothing, and
 * the oracle resolves every payment as `FOREIGN_CONSUMER`. The product would
 * not be broken in a subtle way; it would not work at all.
 *
 * So this runs first, alone, before anything is built on top of it.
 *
 * **The method**, which is deliberately not "ask the wallet":
 *
 *   1. Build a durable nonce transaction and record the compiled message hash
 *      *before* the wallet is opened.
 *   2. Hand it to the wallet.
 *   3. Read back from the chain what the cluster actually received.
 *   4. Recompute the hash from the returned message bytes and compare.
 *   5. Read the nonce account and confirm it advanced.
 *
 * A wallet cannot pass this by reporting success. The comparison is against
 * bytes the chain returned, not against anything the wallet said.
 */

import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { MMKV } from 'react-native-mmkv';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Connection,
  Keypair,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

import {
  bytesToBase64,
  hashCompiledMessage,
  hashCompiledMessageBase64,
  digestsEqual,
} from '@quittance/engine';

import { PrimaryButton } from '../components/PrimaryButton';
import { space, type Palette } from '../design/tokens';
import { APP_IDENTITY, CHAIN, describeWalletFailure } from '../wallet/mwa';
import { config } from '../config';

/**
 * Which second transaction the probe hands the wallet.
 *
 * - `E8`: the gate. Nonce value in the blockhash field, `AdvanceNonce` first.
 * - `CONTROL`: a recent blockhash, no `AdvanceNonce`. An ordinary payment.
 * - `CONTROL_B`: a recent blockhash *with* `AdvanceNonce`. Not durable, so a
 *   diagnostic only, but it separates "the instruction" from "the field".
 *
 * Run back to back they say which part of the durable shape a wallet refuses.
 */
export type ProbeMode = 'E8' | 'CONTROL' | 'CONTROL_B';

/** The last measured result per wallet, read by the Pay screen. */
export const walletRecord = new MMKV({ id: 'quittance-wallet-record' });

export interface ProbeStep {
  readonly label: string;
  readonly detail: string;
  readonly state: 'pending' | 'running' | 'pass' | 'fail';
}

export interface ProbeScreenProps {
  readonly colors: Palette;
  readonly onBack: () => void;
}

export function ProbeScreen(props: ProbeScreenProps): React.JSX.Element {
  const { colors } = props;
  const [steps, setSteps] = useState<readonly ProbeStep[]>([]);
  const [running, setRunning] = useState(false);
  const [verdict, setVerdict] = useState<null | { pass: boolean; summary: string }>(null);
  const [report, setReport] = useState<string>('');
  const [operatorNote, setOperatorNote] = useState('');

  const push = useCallback((step: ProbeStep) => {
    setSteps((current) => [...current, step]);
  }, []);

  const run = useCallback(async (mode: ProbeMode) => {
    setSteps([]);
    setVerdict(null);
    setReport('');
    setRunning(true);

    const connection = new Connection(config.rpcUrl, 'finalized');
    const collected: Record<string, unknown> = { mode };

    try {
      // --- connect ---------------------------------------------------------
      const { transact } = await import(
        '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
      );

      let walletLabel = 'unknown';
      let account: PublicKey | null = null;
      let authToken = '';
      let rawCapabilities: unknown = null;

      await withRetry(() => transact(async (wallet) => {
        const authorization = await wallet.authorize({
          chain: CHAIN,
          identity: APP_IDENTITY,
        });
        const first = authorization.accounts[0];
        if (first === undefined) throw new Error('the wallet returned no account');
        account = new PublicKey(base64ToPubkeyBytes(first.address));
        authToken = authorization.auth_token;
        walletLabel = first.label ?? authorization.wallet_uri_base ?? 'unknown';
        try {
          rawCapabilities = await wallet.getCapabilities();
        } catch {
          rawCapabilities = null;
        }
      }));

      if (account === null) throw new Error('no account');
      const member: PublicKey = account;

      collected['wallet'] = walletLabel;
      collected['account'] = member.toBase58();
      collected['capabilities'] = rawCapabilities;

      push({
        label: 'E7 · capability probe',
        detail: `${walletLabel} · ${
          rawCapabilities === null
            ? 'getCapabilities not answered, recorded as mandatory-only'
            : JSON.stringify(rawCapabilities).slice(0, 160)
        }`,
        state: 'pass',
      });

      // --- the nonce account ----------------------------------------------
      //
      // Created and owned by the member, so this probe needs no funded service
      // key and anyone can reproduce it on their own device.
      push({ label: 'creating a nonce account', detail: 'rent-exempt, 80 bytes', state: 'running' });

      const nonceKeypair = Keypair.generate();
      const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
      const { blockhash } = await connection.getLatestBlockhash('finalized');

      const create = new Transaction();
      create.add(
        SystemProgram.createAccount({
          fromPubkey: member,
          newAccountPubkey: nonceKeypair.publicKey,
          lamports: rent,
          space: NONCE_ACCOUNT_LENGTH,
          programId: SystemProgram.programId,
        }),
        SystemProgram.nonceInitialize({
          noncePubkey: nonceKeypair.publicKey,
          authorizedPubkey: member,
        }),
      );
      create.feePayer = member;
      create.recentBlockhash = blockhash;
      // The new account must sign its own creation; the member signs the rest
      // through the wallet.
      create.partialSign(nonceKeypair);

      const createSignatures = await withRetry(() =>
        transact(async (wallet) => {
          await wallet.reauthorize({ auth_token: authToken, identity: APP_IDENTITY });
          return wallet.signAndSendTransactions({ transactions: [create] });
        }),
      );

      collected['nonceAccount'] = nonceKeypair.publicKey.toBase58();
      collected['createSignature'] = createSignatures[0];

      await waitForFinalized(connection, createSignatures[0] as string);

      push({
        label: 'creating a nonce account',
        detail: nonceKeypair.publicKey.toBase58(),
        state: 'pass',
      });

      // The wallet validates the transaction against its own RPC, which can
      // trail ours by several seconds. A durable nonce transaction names an
      // account that did not exist a moment ago, and a wallet that cannot see
      // it may misreport the network. Give it time before handing it over.
      push({
        label: 'letting the wallet RPC see the new account',
        detail: 'waiting 25 seconds',
        state: 'running',
      });
      await new Promise((resolve) => setTimeout(resolve, 25_000));

      // --- build, hash, then hand over -------------------------------------

      const nonceInfo = await readNonce(connection, nonceKeypair.publicKey);
      if (nonceInfo === null) throw new Error('the nonce account did not initialize');

      const durable = new Transaction();
      // E8 carries the nonce value in the blockhash field. The controls carry a
      // fresh recent blockhash, so the only thing that changes between runs is
      // the part of the durable shape being isolated.
      const fieldValue =
        mode === 'E8'
          ? nonceInfo
          : (await connection.getLatestBlockhash('confirmed')).blockhash;
      if (mode !== 'CONTROL') {
        durable.add(
          SystemProgram.nonceAdvance({
            noncePubkey: nonceKeypair.publicKey,
            authorizedPubkey: member,
          }),
        );
      }
      durable.add(
        SystemProgram.transfer({
          fromPubkey: member,
          toPubkey: member,
          lamports: 1,
        }),
      );
      durable.feePayer = member;
      // The substitution under test.
      durable.recentBlockhash = fieldValue;

      const builtMessage = new Uint8Array(durable.serializeMessage());
      const builtHash = hashCompiledMessage(builtMessage);

      collected['nonceValueAtBuild'] = nonceInfo;
      collected['builtMessageHash'] = builtHash;
      collected['builtMessageBase64'] = bytesToBase64(builtMessage);

      push({
        label: 'built a durable nonce transaction',
        detail: `nonce ${nonceInfo.slice(0, 12)}… · hash ${builtHash.slice(0, 16)}…`,
        state: 'pass',
      });

      push({ label: 'E8 · handing it to the wallet', detail: 'awaiting approval', state: 'running' });

      const signatures = await withRetry(() =>
        transact(async (wallet) => {
          await wallet.reauthorize({ auth_token: authToken, identity: APP_IDENTITY });
          return wallet.signAndSendTransactions({ transactions: [durable] });
        }),
      );

      const signature = signatures[0] as string;
      collected['sentSignature'] = signature;

      await waitForFinalized(connection, signature);

      // --- read back what the chain actually received ----------------------

      const landed = await connection.getTransaction(signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });
      if (landed === null) throw new Error('the chain did not return the transaction');

      const landedMessage = new Uint8Array(landed.transaction.message.serialize());
      const landedBase64 = bytesToBase64(landedMessage);
      const landedHash = hashCompiledMessageBase64(landedBase64);
      const landedBlockhashField = landed.transaction.message.recentBlockhash;

      collected['landedMessageHash'] = landedHash;
      collected['landedBlockhashField'] = landedBlockhashField;
      collected['landedError'] = landed.meta?.err ?? null;

      const preserved = digestsEqual(landedHash, builtHash);
      const nonceStillInField = landedBlockhashField === fieldValue;

      push({
        label: 'E8 · comparing what the chain received',
        detail: preserved
          ? `identical — the wallet broadcast the message it was given`
          : `DIFFERENT — built ${builtHash.slice(0, 16)}…, chain has ${landedHash.slice(0, 16)}…`,
        state: preserved ? 'pass' : 'fail',
      });

      push({
        label: 'the blockhash field survived',
        detail: nonceStillInField
          ? `${landedBlockhashField.slice(0, 16)}… matches the value built against`
          : `REWRITTEN to ${landedBlockhashField.slice(0, 16)}…`,
        state: nonceStillInField ? 'pass' : 'fail',
      });

      // --- the nonce advanced ---------------------------------------------

      const nonceAfter = await readNonce(connection, nonceKeypair.publicKey);
      const advanced = nonceAfter !== null && nonceAfter !== nonceInfo;
      // CONTROL has no AdvanceNonce, so the nonce is expected to stay put.
      const advanceOk = mode === 'CONTROL' ? !advanced : advanced;
      collected['nonceAfter'] = nonceAfter;

      push({
        label: 'the nonce advanced',
        detail: advanced
          ? `${nonceInfo.slice(0, 10)}… → ${(nonceAfter ?? '').slice(0, 10)}…`
          : 'it did not advance',
        state: advanceOk ? 'pass' : 'fail',
      });

      const pass = preserved && nonceStillInField && advanceOk;
      collected['verdict'] = pass ? 'PASS' : 'FAIL';
      if (operatorNote.trim().length > 0) collected['operatorNote'] = operatorNote.trim();
      walletRecord.set(
        `result.${mode}`,
        JSON.stringify({ wallet: walletLabel, mode, pass, at: Date.now() }),
      );

      setVerdict({
        pass,
        summary: pass
          ? mode === 'E8'
            ? `${walletLabel} preserves durable nonces. The thesis holds on this wallet.`
            : `${walletLabel} passed the ${mode === 'CONTROL' ? 'plain-payment' : 'recent-blockhash-with-advance'} control.`
          : `${walletLabel} did not hand back the transaction it was given. Nothing here says which part it objected to; compare the controls.`,
      });
      setReport(JSON.stringify(collected, null, 2));
    } catch (error) {
      push({
        label: 'the probe did not complete',
        detail: describeWalletFailure(error),
        state: 'fail',
      });
      collected['error'] = error instanceof Error ? error.message : String(error);
      // The raw error, so the record shows what the wallet layer actually
      // returned rather than only the sentence we chose for the screen.
      collected['walletError'] = {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      };
      if (operatorNote.trim().length > 0) collected['operatorNote'] = operatorNote.trim();
      walletRecord.set(
        `result.${mode}`,
        JSON.stringify({ wallet: 'unknown', mode, pass: false, refused: true, at: Date.now() }),
      );
      setReport(JSON.stringify(collected, null, 2));
    } finally {
      setRunning(false);
    }
  }, [push, operatorNote]);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.paper }]} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.title, { color: colors.ink }]}>E8 — the gate</Text>
        <Text style={[styles.lede, { color: colors.inkSoft }]}>
          Builds a durable nonce payment, hands it to your wallet, then reads back from the
          chain what the cluster actually received and compares it to what was built. The
          wallet cannot pass this by claiming success.
        </Text>

        {steps.map((step, index) => (
          <View key={`${step.label}-${index}`} style={styles.step}>
            <Text
              style={[
                styles.mark,
                {
                  color:
                    step.state === 'pass'
                      ? colors.settled
                      : step.state === 'fail'
                        ? colors.rejected
                        : colors.inkFaint,
                },
              ]}
            >
              {step.state === 'pass' ? 'PASS' : step.state === 'fail' ? 'FAIL' : '····'}
            </Text>
            <View style={styles.stepText}>
              <Text style={[styles.stepLabel, { color: colors.ink }]}>{step.label}</Text>
              <Text style={[styles.stepDetail, { color: colors.inkSoft }]}>{step.detail}</Text>
            </View>
          </View>
        ))}

        {verdict !== null ? (
          <View
            style={[
              styles.verdict,
              { backgroundColor: colors.paperSunk, borderColor: verdict.pass ? colors.settled : colors.rejected },
            ]}
          >
            <Text
              style={[styles.verdictTitle, { color: verdict.pass ? colors.settled : colors.rejected }]}
            >
              {verdict.pass ? 'E8 PASSES' : 'E8 FAILS'}
            </Text>
            <Text style={[styles.verdictBody, { color: colors.ink }]}>{verdict.summary}</Text>
          </View>
        ) : null}

        {report.length > 0 ? (
          <View style={[styles.report, { backgroundColor: colors.paperSunk }]}>
            <Text style={[styles.reportText, { color: colors.ink }]} selectable>
              {report}
            </Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          <PrimaryButton
            label={running ? 'Running' : 'Run E8'}
            onPress={() => void run('E8')}
            colors={colors}
            busy={running}
            disabled={running}
          />
          <PrimaryButton
            label="Run control (recent blockhash, no advance)"
            onPress={() => void run('CONTROL')}
            colors={colors}
            variant="secondary"
            disabled={running}
          />
          <PrimaryButton
            label="Run control B (recent blockhash, with advance)"
            onPress={() => void run('CONTROL_B')}
            colors={colors}
            variant="secondary"
            disabled={running}
          />
          <TextInput
            value={operatorNote}
            onChangeText={setOperatorNote}
            placeholder="What the wallet showed, in your words"
            placeholderTextColor={colors.inkFaint}
            style={[styles.note, { color: colors.ink, borderColor: colors.rule }]}
          />
          <PrimaryButton label="Back" onPress={props.onBack} colors={colors} variant="secondary" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Retry a wallet session that failed to *connect*.
 *
 * Mobile Wallet Adapter opens a local websocket to the wallet after launching
 * it by intent; if the wallet activity is slow to start the handshake throws
 * `ConnectionFailedException` before anything has been signed, so repeating it
 * is safe. Anything else — a declined request, a wallet error — is rethrown
 * untouched, because retrying those could ask a person to approve twice.
 */
async function withRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const connectOnly = /ConnectionFailed|Unable to connect to websocket/i.test(message);
      if (!connectOnly || tries >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
}

async function readNonce(connection: Connection, pubkey: PublicKey): Promise<string | null> {
  const account = await connection.getAccountInfo(pubkey, 'finalized');
  if (account === null || account.data.length < NONCE_ACCOUNT_LENGTH) return null;
  return NonceAccount.fromAccountData(account.data).nonce;
}

/**
 * Poll for finality rather than subscribing.
 *
 * `confirmTransaction` opens a websocket subscription per call; a loop of them
 * exhausted the heap in the Node version of these experiments, and the device
 * has far less headroom.
 */
async function waitForFinalized(connection: Connection, signature: string): Promise<void> {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const status = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    if (status.value?.confirmationStatus === 'finalized') return;
    if (status.value?.err != null) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${signature} did not finalize within 90 seconds`);
}

/** MWA returns account addresses as base64 rather than base58. */
function base64ToPubkeyBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { padding: space.lg, paddingBottom: space.xxxl, gap: space.md },
  title: { fontFamily: 'Fraunces', fontSize: 28, lineHeight: 34, letterSpacing: -0.4 },
  lede: { fontFamily: 'Geist', fontSize: 15, lineHeight: 23 },
  step: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  mark: { fontFamily: 'GeistMono', fontSize: 12, lineHeight: 20, width: 40 },
  stepText: { flex: 1, gap: 2 },
  stepLabel: { fontFamily: 'Geist', fontSize: 14, lineHeight: 20 },
  stepDetail: { fontFamily: 'GeistMono', fontSize: 11, lineHeight: 17 },
  verdict: { padding: space.lg, gap: space.sm, borderLeftWidth: 3 },
  verdictTitle: { fontFamily: 'GeistMono', fontSize: 14, lineHeight: 20 },
  verdictBody: { fontFamily: 'Geist', fontSize: 15, lineHeight: 23 },
  report: { padding: space.md },
  reportText: { fontFamily: 'GeistMono', fontSize: 10, lineHeight: 16 },
  actions: { paddingTop: space.lg, gap: space.md },
  note: { fontFamily: 'Geist', fontSize: 14, borderWidth: 1, padding: space.sm },
});

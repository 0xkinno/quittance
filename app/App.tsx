/**
 * Quittance.
 *
 * A savings circle that collects every contribution on a phone that dies
 * mid-payment and still knows, with certainty, who paid and who did not.
 *
 * The navigation here is a plain state machine rather than a router, because
 * the app is seven screens with one entry point and the thing that decides
 * what you see is not a URL — it is whether there is an unresolved payment.
 * A member who crashed mid-payment lands on Recovering before anything else,
 * every time, without having to ask for it.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Connection } from '@solana/web3.js';
import 'react-native-get-random-values';

import { Web3ChainReader, isTerminal } from '@quittance/engine';
import type { StoredSlot } from '@quittance/engine';

import { loadFonts } from './src/design/fonts';
import { darkPalette, palette, space } from './src/design/tokens';
import { MmkvIntentStore } from './src/storage/mmkv-store';
import { CircleScreen } from './src/screens/CircleScreen';
import { CollectionDayScreen } from './src/screens/CollectionDayScreen';
import { PayScreen } from './src/screens/PayScreen';
import { ProofScreen } from './src/screens/ProofScreen';
import { ReceiptScreen } from './src/screens/ReceiptScreen';
import { RecoveringScreen } from './src/screens/RecoveringScreen';
import { ResolveScreen } from './src/screens/ResolveScreen';
import { useCircle } from './src/state/useCircle';
import { DEMO_CIRCLE, config } from './src/config';

type Route =
  | { readonly name: 'CIRCLE' }
  | { readonly name: 'PAY' }
  | { readonly name: 'RECOVERING'; readonly slotId: string }
  | { readonly name: 'COLLECTION' }
  | { readonly name: 'RESOLVE'; readonly slotId: string }
  | { readonly name: 'RECEIPT'; readonly slotId: string }
  | { readonly name: 'PROOF' };

export default function App(): React.JSX.Element {
  const scheme = useColorScheme();
  const colors = scheme === 'dark' ? darkPalette : palette;

  const [fontsReady, setFontsReady] = useState(false);
  const [route, setRoute] = useState<Route>({ name: 'CIRCLE' });

  const store = useMemo(() => new MmkvIntentStore(), []);
  const reader = useMemo(
    () => new Web3ChainReader(new Connection(config.rpcUrl, 'finalized')),
    [],
  );

  useEffect(() => {
    void loadFonts().then(() => setFontsReady(true));
  }, []);

  const circle = useCircle({
    definition: DEMO_CIRCLE,
    store,
    reader,
    roundIndex: config.roundIndex,
    youPubkey: config.youPubkey,
    wallet: null,
    raw: null,
  });

  /**
   * The automatic jump to Recovering.
   *
   * If a slot belonging to this member is non-terminal when the app opens,
   * that member crashed mid-payment, and the first thing they should see is
   * the answer rather than a ledger row that is quietly out of date.
   */
  useEffect(() => {
    if (circle.isResolving) return;
    if (route.name !== 'CIRCLE') return;

    const unresolved = circle.slots.find(
      (slot) => slot.intent.memberPubkey === config.youPubkey && !isTerminal(slot.state),
    );
    if (unresolved !== undefined) {
      setRoute({ name: 'RECOVERING', slotId: unresolved.intent.slotId });
    }
  }, [circle.isResolving, circle.slots, route.name]);

  const slotById = useCallback(
    (slotId: string): StoredSlot | undefined =>
      circle.slots.find((slot) => slot.intent.slotId === slotId),
    [circle.slots],
  );

  if (!fontsReady) {
    // Deliberately bare. The first thing a member sees should be their circle,
    // not a branded splash, and the fonts load from the bundle in well under a
    // second — a logo here would be a loading screen inserted for its own sake.
    return (
      <View style={[styles.boot, { backgroundColor: colors.paper }]}>
        <ActivityIndicator color={colors.inkSoft} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {renderRoute()}
    </SafeAreaProvider>
  );

  function renderRoute(): React.JSX.Element {
    switch (route.name) {
      case 'CIRCLE':
        return (
          <CircleScreen
            circleName={DEMO_CIRCLE.name}
            roundIndex={config.roundIndex}
            roundCount={DEMO_CIRCLE.roundCount}
            recipientName={circle.recipientName}
            contributionRaw={DEMO_CIRCLE.contributionRaw}
            decimals={DEMO_CIRCLE.mintDecimals}
            members={circle.rows}
            colors={colors}
            isRefreshing={circle.isRefreshing}
            isResolving={circle.isResolving}
            readError={circle.readError}
            onRefresh={() => void circle.refresh()}
            onPayPress={() => setRoute({ name: 'PAY' })}
            onCollectionDayPress={() => setRoute({ name: 'COLLECTION' })}
            onMemberPress={(memberPubkey) => {
              const slot = circle.slots.find(
                (candidate) =>
                  candidate.intent.memberPubkey === memberPubkey &&
                  candidate.intent.roundIndex === config.roundIndex,
              );
              if (slot === undefined) return;
              setRoute(
                slot.state === 'AMBIGUOUS'
                  ? { name: 'RESOLVE', slotId: slot.intent.slotId }
                  : { name: 'RECEIPT', slotId: slot.intent.slotId },
              );
            }}
          />
        );

      case 'PAY':
        return (
          <PayScreen
            circleName={DEMO_CIRCLE.name}
            roundIndex={config.roundIndex}
            recipientName={circle.recipientName}
            rawAmount={DEMO_CIRCLE.contributionRaw}
            decimals={DEMO_CIRCLE.mintDecimals}
            phase="READY"
            errorMessage={null}
            colors={colors}
            leaseIsStandIn={!config.skrMintIsGenuine}
            onPay={() => setRoute({ name: 'CIRCLE' })}
            onDone={() => setRoute({ name: 'CIRCLE' })}
            onRetry={() => setRoute({ name: 'PAY' })}
          />
        );

      case 'RECOVERING': {
        const slot = slotById(route.slotId);
        return (
          <RecoveringScreen
            phase={
              circle.isResolving
                ? 'READING'
                : circle.readError !== null
                  ? 'UNREACHABLE'
                  : 'RESOLVED'
            }
            state={slot?.state ?? null}
            reason={slot?.verdict?.reason ?? null}
            rawAmount={slot?.intent.transfer.expectedAmount ?? DEMO_CIRCLE.contributionRaw}
            decimals={DEMO_CIRCLE.mintDecimals}
            recipientName={circle.recipientName}
            elapsedMs={circle.medianVerdictMs}
            colors={colors}
            onContinue={() => setRoute({ name: 'CIRCLE' })}
            onRetry={() => void circle.refresh()}
            onResolvePress={() => setRoute({ name: 'RESOLVE', slotId: route.slotId })}
          />
        );
      }

      case 'COLLECTION':
        return (
          <CollectionDayScreen
            circleName={DEMO_CIRCLE.name}
            roundIndex={config.roundIndex}
            recipientName={circle.recipientName}
            contributionRaw={DEMO_CIRCLE.contributionRaw}
            decimals={DEMO_CIRCLE.mintDecimals}
            members={circle.rows}
            colors={colors}
            alreadyDisbursed={false}
            busy={false}
            errorMessage={null}
            onPayOut={() => setRoute({ name: 'PROOF' })}
            onResolvePress={(memberPubkey) => {
              const slot = circle.slots.find(
                (candidate) => candidate.intent.memberPubkey === memberPubkey,
              );
              if (slot !== undefined) {
                setRoute({ name: 'RESOLVE', slotId: slot.intent.slotId });
              }
            }}
            onBack={() => setRoute({ name: 'CIRCLE' })}
          />
        );

      case 'RESOLVE': {
        const slot = slotById(route.slotId);
        if (slot === undefined || slot.verdict === null || slot.verdict.reason === null) {
          return (
            <View style={[styles.boot, { backgroundColor: colors.paper }]}>
              <Text style={[styles.missing, { color: colors.inkSoft }]}>
                That contribution is no longer waiting on a decision.
              </Text>
            </View>
          );
        }
        return (
          <ResolveScreen
            memberName={
              DEMO_CIRCLE.members.find(
                (member) => member.pubkey === slot.intent.memberPubkey,
              )?.name ?? 'This member'
            }
            reason={slot.verdict.reason}
            noncePubkey={slot.intent.noncePubkey}
            consumingSignature={slot.verdict.evidence.consumingSignature}
            expectedRaw={slot.intent.transfer.expectedAmount}
            observedRaw={slot.verdict.evidence.observedRawDelta}
            decimals={DEMO_CIRCLE.mintDecimals}
            explorerBaseUrl={config.explorerBaseUrl}
            colors={colors}
            isOrganizer={config.youPubkey === config.organizerPubkey}
            busy={false}
            errorMessage={null}
            onMarkUnpaidAndReissue={() => setRoute({ name: 'CIRCLE' })}
            onAcceptAsPaid={() => setRoute({ name: 'CIRCLE' })}
            onBack={() => setRoute({ name: 'CIRCLE' })}
          />
        );
      }

      case 'RECEIPT': {
        const slot = slotById(route.slotId);
        if (slot === undefined) {
          return (
            <View style={[styles.boot, { backgroundColor: colors.paper }]}>
              <Text style={[styles.missing, { color: colors.inkSoft }]}>
                There is no record for that contribution yet.
              </Text>
            </View>
          );
        }
        return (
          <ReceiptScreen
            circleName={DEMO_CIRCLE.name}
            roundIndex={slot.intent.roundIndex}
            memberName={
              DEMO_CIRCLE.members.find(
                (member) => member.pubkey === slot.intent.memberPubkey,
              )?.name ?? 'This member'
            }
            state={slot.state}
            rawAmount={slot.intent.transfer.expectedAmount}
            decimals={slot.intent.transfer.mintDecimals}
            noncePubkey={slot.intent.noncePubkey}
            consumingSignature={slot.verdict?.evidence.consumingSignature ?? null}
            settledAtMs={slot.verdict?.decidedAtMs ?? null}
            wasHumanDecision={slot.override !== null}
            decidedBy={slot.override?.decidedBy ?? null}
            explorerBaseUrl={config.explorerBaseUrl}
            colors={colors}
            onBack={() => setRoute({ name: 'CIRCLE' })}
          />
        );
      }

      case 'PROOF':
        return (
          <ProofScreen
            campaign={null}
            invariants={[]}
            programId={config.programId}
            explorerBaseUrl={config.explorerBaseUrl}
            verifierCommand={config.verifierCommand}
            colors={colors}
            onBack={() => setRoute({ name: 'CIRCLE' })}
          />
        );
    }
  }
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  missing: { fontFamily: 'Geist', fontSize: 16, lineHeight: 24, textAlign: 'center' },
});

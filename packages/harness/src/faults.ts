/**
 * The fault corpus.
 *
 * Ten faults, each one a specific way a payment on a phone can be
 * interrupted, and each one injected against real hardware rather than
 * simulated in software.
 *
 * The corpus is run identically against both arms. That is the whole design:
 * the comparison is only worth something if the baseline faced exactly what
 * Quittance faced, on the same device, in the same session.
 */

import type { Adb } from './adb.ts';
import { sleep } from './adb.ts';

export type FaultId =
  | 'F1'
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F5'
  | 'F6'
  | 'F7'
  | 'F8'
  | 'F9'
  | 'F10';

/**
 * Where in the payment sequence a fault fires.
 *
 * The app emits a breakpoint marker to logcat as it passes each of these, and
 * the harness waits for the marker before injecting. Injecting on a timer
 * instead would make the campaign non-reproducible: a slow network would move
 * the kill to a different step and the row would be mislabelled.
 */
export type Breakpoint =
  | 'INTENT_PERSISTED'
  | 'WALLET_FOREGROUND'
  | 'WALLET_APPROVED'
  | 'SESSION_RETURNED'
  | 'RESOLVER_RUNNING';

export interface FaultDefinition {
  readonly id: FaultId;
  readonly title: string;
  /** What this fault is actually testing. Goes into the README table. */
  readonly question: string;
  readonly breakpoint: Breakpoint | null;
  /** Whether a human has to approve in the wallet for this fault to be valid. */
  readonly needsWalletApproval: boolean;
}

export const FAULT_CORPUS: readonly FaultDefinition[] = [
  {
    id: 'F1',
    title: 'Kill after the intent is written, before the wallet is called',
    question:
      'Does a crash in the gap between the durable write and the handoff leave a record that can be resolved?',
    breakpoint: 'INTENT_PERSISTED',
    needsWalletApproval: false,
  },
  {
    id: 'F2',
    title: 'Kill while the wallet is in the foreground, before approval',
    question: 'Does an app killed during the handoff recover without charging anyone?',
    breakpoint: 'WALLET_FOREGROUND',
    needsWalletApproval: false,
  },
  {
    id: 'F3',
    title: 'Kill after approval, before the session returns',
    question:
      'The money shot. The payment is on its way and the app that sent it no longer exists. Can it still find out?',
    breakpoint: 'WALLET_APPROVED',
    needsWalletApproval: true,
  },
  {
    id: 'F4',
    title: 'Airplane mode toggled mid-broadcast',
    question: 'Does losing the network mid-send produce a wrong answer or no answer?',
    breakpoint: 'WALLET_APPROVED',
    needsWalletApproval: true,
  },
  {
    id: 'F5',
    title: 'Forced reboot between broadcast and resolution',
    question:
      'Nothing in memory survives a cold boot. Is the stored record alone enough to reach the verdict?',
    breakpoint: 'WALLET_APPROVED',
    needsWalletApproval: true,
  },
  {
    id: 'F6',
    title: 'RPC timeout and stale-slot responses',
    question:
      'Does a misbehaving node produce a confident wrong verdict, or an honest refusal to decide?',
    breakpoint: 'RESOLVER_RUNNING',
    needsWalletApproval: true,
  },
  {
    id: 'F7',
    title: 'Rebroadcast identical bytes ten times after it landed',
    question:
      'Can a dumb retry loop double-charge? The runtime should drop nine and let one through.',
    breakpoint: 'SESSION_RETURNED',
    needsWalletApproval: true,
  },
  {
    id: 'F8',
    title: 'Nonce consumed by a foreign transaction',
    question:
      'When something else takes the slot, does the app escalate honestly or quietly guess?',
    breakpoint: 'WALLET_FOREGROUND',
    needsWalletApproval: false,
  },
  {
    id: 'F9',
    title: 'Two concurrent disburse calls on one round',
    question: 'Can a round pay out twice?',
    breakpoint: null,
    needsWalletApproval: false,
  },
  {
    id: 'F10',
    title: 'Kill during the recovery resolver itself',
    question:
      'Does being killed mid-resolve corrupt the record, or cost nothing but a retry?',
    breakpoint: 'RESOLVER_RUNNING',
    needsWalletApproval: true,
  },
];

export function faultById(id: FaultId): FaultDefinition {
  const fault = FAULT_CORPUS.find((candidate) => candidate.id === id);
  if (fault === undefined) throw new Error(`Unknown fault ${id}`);
  return fault;
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

export interface InjectionContext {
  readonly adb: Adb;
  readonly appPackage: string;
  /** Emits a line to logcat when the app reaches a breakpoint. */
  readonly waitForBreakpoint: (
    breakpoint: Breakpoint,
    timeoutMs: number,
  ) => Promise<boolean>;
}

export interface InjectionResult {
  readonly injected: boolean;
  /** Why the fault did not fire, when it did not. Never silently skipped. */
  readonly skippedReason: string | null;
  readonly atMs: number;
}

/**
 * Inject one fault.
 *
 * A fault that could not be injected is reported as skipped with a reason and
 * is excluded from the counts, never counted as a pass. A campaign that
 * silently dropped the faults it could not deliver would report a perfect
 * score for having tried nothing.
 */
export async function inject(
  fault: FaultDefinition,
  context: InjectionContext,
): Promise<InjectionResult> {
  const atMs = Date.now();

  if (fault.breakpoint !== null) {
    const reached = await context.waitForBreakpoint(fault.breakpoint, 120_000);
    if (!reached) {
      return {
        injected: false,
        skippedReason: `the app never reached ${fault.breakpoint}`,
        atMs,
      };
    }
  }

  switch (fault.id) {
    case 'F1':
    case 'F2':
    case 'F3':
    case 'F10':
      await context.adb.forceStop(context.appPackage);
      return { injected: true, skippedReason: null, atMs };

    case 'F4':
      await context.adb.setAirplaneMode(true);
      await sleep(5_000);
      await context.adb.setAirplaneMode(false);
      return { injected: true, skippedReason: null, atMs };

    case 'F5':
      await context.adb.reboot();
      return { injected: true, skippedReason: null, atMs };

    case 'F6':
      // Injected by the local fault proxy rather than over adb. The proxy
      // sits between the app and the RPC endpoint and is configured by the
      // campaign driver before the run starts.
      return { injected: true, skippedReason: null, atMs };

    case 'F7':
    case 'F8':
    case 'F9':
      // Driven from the host against the cluster, not against the device:
      // these need an independent signer or a second concurrent caller, which
      // is a thing the phone cannot be.
      return { injected: true, skippedReason: null, atMs };
  }
}

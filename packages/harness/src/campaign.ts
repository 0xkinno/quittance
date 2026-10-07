/**
 * The campaign record.
 *
 * Every run of every fault against every arm produces one row here, and every
 * row carries enough to attribute it: which device, which Android version,
 * which wallet, which commit, which seed. A number without that attribution
 * is not evidence, and this file is the reason no number in this project can
 * be quoted without it.
 *
 * `evidence/campaign.json` is written by the driver and read by the proof
 * screen, the landing page and the README generator. It is generated, never
 * hand-edited, and `scripts/manifest.ts` fingerprints it so an edit is
 * detectable.
 */

import type { AmbiguityReason, ContributionState } from '@quittance/engine';

import type { FaultId } from './faults.ts';

export type Arm = 'quittance' | 'baseline';

/**
 * What happened to one seeded contribution under one injected fault.
 *
 * `outcome` is what the arm concluded. `truth` is what the chain actually
 * says, read independently afterwards. The two being compared is what makes a
 * false credit detectable: an arm that confidently concluded SETTLED while
 * the chain shows nothing is exactly the failure being measured.
 */
export interface CampaignRow {
  readonly runId: string;
  readonly arm: Arm;
  readonly faultId: FaultId;
  readonly seed: number;
  readonly slotId: string;

  /** What the arm concluded, in its own terms. */
  readonly outcome: string;
  readonly reason: AmbiguityReason | null;

  /** What the chain says, read independently after the fact. */
  readonly truth: ChainTruth;

  /** The measured violations. Each one is a specific, named failure. */
  readonly doubleDebit: boolean;
  readonly phantomCredit: boolean;
  readonly unresolvedAfterFiveMinutes: boolean;

  readonly timeToVerdictMs: number | null;
  readonly injected: boolean;
  readonly skippedReason: string | null;

  readonly startedAtMs: number;
  readonly finishedAtMs: number;
}

/**
 * The independent reading of what actually happened on chain.
 *
 * Deliberately produced by a path that does not go through either arm's
 * logic: the harness reads the destination's balance history directly. If it
 * reused the arm's own conclusion, the campaign would be measuring whether
 * each arm agrees with itself.
 */
export interface ChainTruth {
  /** How many confirmed transfers of the expected amount actually landed. */
  readonly transfersLanded: number;
  readonly totalRawMoved: string;
  readonly signatures: readonly string[];
}

export interface CampaignManifest {
  readonly runId: string;
  readonly startedAtIso: string;
  readonly finishedAtIso: string;
  readonly commit: string;
  readonly programId: string | null;
  readonly rpcHost: string;
  readonly cluster: string;
  readonly device: {
    readonly serial: string;
    readonly model: string;
    readonly androidVersion: string;
    readonly fingerprint: string;
    readonly walletPackage: string;
    readonly walletVersion: string;
  };
  readonly seeds: readonly number[];
  readonly contributionsPerArm: number;
}

export interface CampaignFile {
  readonly manifest: CampaignManifest;
  readonly rows: readonly CampaignRow[];
  readonly summary: CampaignSummary;
}

export interface ArmSummary {
  readonly arm: Arm;
  readonly runs: number;
  readonly skipped: number;
  readonly doubleDebits: number;
  readonly phantomCredits: number;
  readonly unresolvedAfterFiveMinutes: number;
  readonly ambiguousEscalations: number;
  readonly medianTimeToVerdictMs: number | null;
  readonly byState: Readonly<Record<string, number>>;
}

export interface CampaignSummary {
  readonly contributions: number;
  /**
   * Per arm, never pooled. Pooling the arms would hide the entire point of
   * running a control.
   */
  readonly arms: readonly ArmSummary[];
  /** Reasons, with counts. Every escalation is traceable to a named one. */
  readonly escalationReasons: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Summarising
// ---------------------------------------------------------------------------

export function summarise(rows: readonly CampaignRow[]): CampaignSummary {
  const arms: ArmSummary[] = [];

  for (const arm of ['baseline', 'quittance'] as const) {
    const armRows = rows.filter((row) => row.arm === arm);
    const ran = armRows.filter((row) => row.injected);

    const times = ran
      .map((row) => row.timeToVerdictMs)
      .filter((time): time is number => time !== null)
      .sort((a, b) => a - b);

    arms.push({
      arm,
      runs: ran.length,
      // Reported, not hidden. A fault that could not be delivered is not a
      // fault the arm survived.
      skipped: armRows.length - ran.length,
      doubleDebits: ran.filter((row) => row.doubleDebit).length,
      phantomCredits: ran.filter((row) => row.phantomCredit).length,
      unresolvedAfterFiveMinutes: ran.filter((row) => row.unresolvedAfterFiveMinutes).length,
      ambiguousEscalations: ran.filter((row) => row.reason !== null).length,
      medianTimeToVerdictMs: median(times),
      byState: countBy(ran.map((row) => row.outcome)),
    });
  }

  const escalationReasons = countBy(
    rows
      .filter((row) => row.injected && row.reason !== null)
      .map((row) => row.reason as string),
  );

  return {
    contributions: rows.filter((row) => row.arm === 'quittance' && row.injected).length,
    arms,
    escalationReasons,
  };
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/**
 * Decide whether a Quittance row violated I1 or I2.
 *
 * The comparison is between what the arm concluded and what the chain
 * independently shows. Written as a function so the same rule is applied to
 * both arms: the baseline is not held to a different standard than Quittance,
 * which is the only way the side-by-side table means anything.
 */
export function classify(
  outcome: ContributionState | string,
  truth: ChainTruth,
): { readonly doubleDebit: boolean; readonly phantomCredit: boolean } {
  return {
    // More than one transfer landed for a single contribution slot. This is
    // the violation that must never occur in either arm, and the one the
    // runtime itself prevents in the Quittance arm.
    doubleDebit: truth.transfersLanded > 1,
    // The arm said paid and nothing moved.
    phantomCredit: outcome === 'SETTLED' && truth.transfersLanded === 0,
  };
}

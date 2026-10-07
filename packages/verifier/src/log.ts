/**
 * The intent log format.
 *
 * One JSON object per line. Append-only, newline-delimited, and readable by
 * anything — `jq`, a spreadsheet, a person with a text editor. The format is
 * deliberately boring, because the point of the verifier is that a skeptic can
 * run it against a log they did not produce and whose producer they do not
 * trust.
 *
 * The log carries the intent, the verdict the app recorded, and the digest the
 * app computed when it wrote the intent. The verifier recomputes all three
 * independently:
 *
 *   it recomputes the intent digest, to detect an edited record;
 *   it re-reads the chain, to build its own snapshot;
 *   it re-runs the identical verdict function, to detect a diverged verdict.
 *
 * Those are three separate failures and the verifier reports them separately.
 */

import type {
  AmbiguityReason,
  ContributionState,
  HumanOverride,
  IntentRecord,
  Verdict,
} from '@quittance/engine';

/** One line of `evidence/intents.jsonl`. */
export interface IntentLogEntry {
  readonly schemaVersion: 1;
  readonly intent: SerializedIntent;
  /** The digest the device computed when it wrote the intent. */
  readonly intentHash: string;
  /** The state the app last recorded for this slot. */
  readonly recordedState: ContributionState;
  /** The verdict the app recorded, when it reached one. */
  readonly recordedVerdict: SerializedVerdict | null;
  readonly recordedOverride: SerializedOverride | null;
  /** Which campaign run produced this row, when it came from the harness. */
  readonly campaignRunId: string | null;
  /** Which fault was injected, when one was. */
  readonly faultId: string | null;
  /** `quittance` or `baseline`. Arms are never pooled. */
  readonly arm: 'quittance' | 'baseline' | null;
}

/**
 * `bigint` cannot cross JSON, so raw amounts travel as decimal strings.
 *
 * Decimal strings rather than numbers, deliberately: a `u64` token amount
 * exceeds the exact integer range of a double, so a JSON number would silently
 * round a large contribution. The one place this system is allowed to be
 * lossy is nowhere.
 */
export interface SerializedIntent extends Omit<IntentRecord, 'transfer'> {
  readonly transfer: {
    readonly expectedFrom: string;
    readonly expectedTo: string;
    readonly expectedMint: string;
    readonly expectedAmount: string;
    readonly mintDecimals: number;
  };
}

export interface SerializedVerdict
  extends Omit<Verdict, 'evidence'> {
  readonly evidence: {
    readonly observedNonceValue: string | null;
    readonly consumingSignature: string | null;
    readonly consumingSlot: number | null;
    readonly observedMessageHash: string | null;
    readonly expectedMessageHash: string;
    readonly expectedRawAmount: string;
    readonly observedRawDelta: string | null;
    readonly programLogs: readonly string[];
    readonly transactionError: unknown;
  };
}

export type SerializedOverride = HumanOverride;

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeIntent(intent: IntentRecord): SerializedIntent {
  return {
    ...intent,
    transfer: {
      expectedFrom: intent.transfer.expectedFrom,
      expectedTo: intent.transfer.expectedTo,
      expectedMint: intent.transfer.expectedMint,
      expectedAmount: intent.transfer.expectedAmount.toString(10),
      mintDecimals: intent.transfer.mintDecimals,
    },
  };
}

export function deserializeIntent(serialized: SerializedIntent): IntentRecord {
  return {
    ...serialized,
    transfer: {
      expectedFrom: serialized.transfer.expectedFrom,
      expectedTo: serialized.transfer.expectedTo,
      expectedMint: serialized.transfer.expectedMint,
      expectedAmount: BigInt(serialized.transfer.expectedAmount),
      mintDecimals: serialized.transfer.mintDecimals,
    },
  };
}

export function serializeVerdict(verdict: Verdict): SerializedVerdict {
  return {
    ...verdict,
    evidence: {
      ...verdict.evidence,
      expectedRawAmount: verdict.evidence.expectedRawAmount.toString(10),
      observedRawDelta:
        verdict.evidence.observedRawDelta === null
          ? null
          : verdict.evidence.observedRawDelta.toString(10),
    },
  };
}

export function deserializeVerdict(serialized: SerializedVerdict): Verdict {
  return {
    ...serialized,
    evidence: {
      ...serialized.evidence,
      expectedRawAmount: BigInt(serialized.evidence.expectedRawAmount),
      observedRawDelta:
        serialized.evidence.observedRawDelta === null
          ? null
          : BigInt(serialized.evidence.observedRawDelta),
    },
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export class IntentLogParseError extends Error {
  readonly line: number;

  constructor(line: number, detail: string) {
    super(`Line ${line} of the intent log could not be read: ${detail}`);
    this.name = 'IntentLogParseError';
    this.line = line;
  }
}

/**
 * Parse newline-delimited JSON into log entries.
 *
 * A malformed line is an error, not a skipped row. A verifier that silently
 * ignored lines it could not parse would report a clean pass over a log it
 * had mostly not read, which is the worst possible failure for this tool.
 */
export function parseIntentLog(contents: string): readonly IntentLogEntry[] {
  const entries: IntentLogEntry[] = [];
  const lines = contents.split('\n');

  for (const [index, raw] of lines.entries()) {
    const text = raw.trim();
    if (text.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new IntentLogParseError(
        index + 1,
        error instanceof Error ? error.message : String(error),
      );
    }

    entries.push(validateEntry(parsed, index + 1));
  }

  return entries;
}

function validateEntry(value: unknown, line: number): IntentLogEntry {
  if (typeof value !== 'object' || value === null) {
    throw new IntentLogParseError(line, 'expected a JSON object');
  }
  const entry = value as Partial<IntentLogEntry>;

  if (entry.schemaVersion !== 1) {
    throw new IntentLogParseError(
      line,
      `unsupported schemaVersion ${String(entry.schemaVersion)}; this verifier reads version 1`,
    );
  }
  if (typeof entry.intentHash !== 'string' || entry.intentHash.length !== 64) {
    throw new IntentLogParseError(line, 'intentHash must be a 64-character sha256 digest');
  }
  if (typeof entry.intent !== 'object' || entry.intent === null) {
    throw new IntentLogParseError(line, 'intent is missing');
  }
  if (typeof entry.recordedState !== 'string') {
    throw new IntentLogParseError(line, 'recordedState is missing');
  }

  const intent = entry.intent as Partial<SerializedIntent>;
  for (const field of [
    'slotId',
    'noncePubkey',
    'nonceValueAtBuild',
    'messageHash',
    'messageBase64',
  ] as const) {
    if (typeof intent[field] !== 'string' || (intent[field] as string).length === 0) {
      throw new IntentLogParseError(line, `intent.${field} is missing`);
    }
  }
  if (typeof intent.builtAtChainSlot !== 'number') {
    throw new IntentLogParseError(line, 'intent.builtAtChainSlot is missing');
  }

  return entry as IntentLogEntry;
}

/** Render one entry as a log line. Used by the harness and the app export. */
export function formatIntentLogLine(entry: IntentLogEntry): string {
  return JSON.stringify(entry);
}

export function ambiguityReasonLabel(reason: AmbiguityReason): string {
  switch (reason) {
    case 'NONCE_ACCOUNT_GONE':
      return 'the nonce account no longer exists';
    case 'BEYOND_RETENTION':
      return 'the nonce advanced and no signature survives in the node\'s retention window';
    case 'FOREIGN_CONSUMER':
      return 'a different transaction consumed the nonce';
    case 'BALANCE_DISAGREES':
      return 'the transaction succeeded and the destination balance disagrees';
    case 'TRANSACTION_UNAVAILABLE':
      return 'a signature exists and the node will not return the transaction';
  }
}

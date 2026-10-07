/**
 * Runtime configuration.
 *
 * Values that differ between a development build and a shipped one, read from
 * the Expo config at build time rather than hardcoded. Nothing secret lives
 * here: the RPC endpoint is the only sensitive value and it is injected at
 * build time from `.env`, never committed.
 */

import Constants from 'expo-constants';

function fromExtra(key: string, fallback: string): string {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  const value = extra?.[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export const config = {
  /**
   * The RPC endpoint.
   *
   * Injected from `.env` through `app.config.js` at build time. The fallback
   * is the public devnet endpoint, which works but rate-limits — a build that
   * silently fell back would produce timings that are not comparable to the
   * campaign's, so `scripts/check-env.mjs` refuses it for anything that
   * produces a number.
   */
  rpcUrl: fromExtra('rpcUrl', 'https://api.devnet.solana.com'),

  cluster: fromExtra('cluster', 'devnet'),

  explorerBaseUrl: `https://explorer.solana.com`,

  /** Appended to every explorer link so devnet addresses resolve. */
  explorerSuffix: fromExtra('cluster', 'devnet') === 'devnet' ? '?cluster=devnet' : '',

  programId: fromExtra('programId', 'BXFpbaNWBy2ZJeQLE3bhRSSRfBqZgP3CVTtFoxCqyvFP'),

  /**
   * Whether the nonce lease runs against the real SKR mint.
   *
   * `false` means a stand-in, and every surface that mentions the lease says
   * so. Nothing in this app presents a stand-in as real.
   */
  skrMintIsGenuine: fromExtra('skrMintIsGenuine', 'false') === 'true',
  skrMint: fromExtra('skrMint', ''),

  /** Filled once the member connects a wallet. */
  youPubkey: '',
  organizerPubkey: '',

  roundIndex: 0,

  verifierCommand: [
    'node packages/verifier/dist/cli.js \\',
    '  --intents evidence/intents.jsonl \\',
    '  --rpc $HELIUS_RPC_URL \\',
    '  --check I1,I2,I3,I4,I5,I6',
  ].join('\n'),
} as const;

/** A circle for the demo build, so the ledger has rows before anyone pays. */
export const DEMO_CIRCLE = {
  circleId: 'thursday-circle',
  name: 'Thursday circle',
  members: [
    { pubkey: 'member-1', name: 'Adaeze N.' },
    { pubkey: 'member-2', name: 'Chidi O.' },
    { pubkey: 'member-3', name: 'Ngozi E.' },
    { pubkey: 'member-4', name: 'Emeka U.' },
    { pubkey: 'member-5', name: 'Funmi A.' },
    { pubkey: 'member-6', name: 'Tunde B.' },
  ],
  rotationOrder: [0, 1, 2, 3, 4, 5],
  /** 20,000.00 of a six-decimal mint. */
  contributionRaw: 20_000_000_000n,
  mintDecimals: 6,
  roundCount: 6,
} as const;

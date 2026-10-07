/**
 * Public configuration.
 *
 * Every value here is read from `NEXT_PUBLIC_*` environment variables with a
 * working default, and every one of them is safe to ship to a browser: a
 * devnet program ID, a public RPC endpoint with no key in it, and an explorer
 * URL. Nothing in this file is a secret, which is the point of the
 * `NEXT_PUBLIC_` prefix — Next.js inlines these into the client bundle at
 * build time, so anything sensitive does not belong here at all.
 *
 * The Helius endpoint used elsewhere in this repository (the harness, the
 * verifier, the experiment scripts) carries an API key and is read from a
 * gitignored `.env` that never leaves the machine that runs those scripts.
 * This page talks to the public devnet RPC instead, precisely so that a
 * stranger's browser never needs a key this project controls.
 */

export const SOLANA_CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? 'devnet';

export const PROGRAM_ID =
  process.env.NEXT_PUBLIC_PROGRAM_ID ?? 'BXFpbaNWBy2ZJeQLE3bhRSSRfBqZgP3CVTtFoxCqyvFP';

/** The public devnet endpoint. No key, so it is safe in a browser bundle. */
export const DEVNET_RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

export const EXPLORER_BASE_URL =
  process.env.NEXT_PUBLIC_EXPLORER_BASE_URL ?? 'https://explorer.solana.com';

export const EXPLORER_PROGRAM_URL = `${EXPLORER_BASE_URL}/address/${PROGRAM_ID}?cluster=${SOLANA_CLUSTER}`;

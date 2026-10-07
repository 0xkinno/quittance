/**
 * Expo configuration, resolved at build time.
 *
 * The RPC endpoint is read from the repository's `.env` and injected into the
 * build rather than committed. `.env` is gitignored; this file is not, and it
 * contains no secret.
 */

const fs = require('node:fs');
const path = require('node:path');

function readEnv(key) {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return '';
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const text = line.trim();
    if (text.startsWith('#') || !text.includes('=')) continue;
    const at = text.indexOf('=');
    if (text.slice(0, at).trim() === key) return text.slice(at + 1).trim();
  }
  return '';
}

module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    // Falls back to the public endpoint so a build without .env still runs.
    // It rate-limits, which is why anything that produces a number checks for
    // the real endpoint first.
    rpcUrl: readEnv('HELIUS_RPC_URL') || 'https://api.devnet.solana.com',
    cluster: readEnv('SOLANA_CLUSTER') || 'devnet',
    programId: 'BXFpbaNWBy2ZJeQLE3bhRSSRfBqZgP3CVTtFoxCqyvFP',
    skrMint: readEnv('SKR_MINT'),
    skrMintIsGenuine: readEnv('SKR_MINT_IS_GENUINE') || 'false',
  },
});

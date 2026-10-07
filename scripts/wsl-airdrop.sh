#!/usr/bin/env bash
#
# Try to top the payer up from the devnet faucet.
#
# The CLI airdrop is rate-limited per address and per IP and fails often. The
# web faucet at https://faucet.solana.com is the reliable path; this is worth
# one attempt first because when it works it saves a round trip.

set -uo pipefail

export PATH="${HOME}/.local/share/solana/install/active_release/bin:${PATH}"

REPO="/mnt/c/Users/hp/Downloads/QUITTANCE"
RPC="$(grep -E '^HELIUS_RPC_URL=' "${REPO}/.env" | head -1 | cut -d= -f2- | tr -d '\r')"
[ -n "${RPC}" ] && solana config set --url "${RPC}" >/dev/null

PAYER="$(solana address)"
echo "  payer    ${PAYER}"
echo "  before   $(solana balance)"
echo

for attempt in 1 2 3; do
  echo "== airdrop attempt ${attempt}"
  if solana airdrop 2 2>&1 | tail -2; then
    break
  fi
  sleep 3
done

echo
echo "  after    $(solana balance)"
echo "  adversary $(solana balance "$(solana address -k "${HOME}/.config/solana/adversary.json")")"

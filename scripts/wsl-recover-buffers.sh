#!/usr/bin/env bash
#
# Reclaim rent from stranded deploy buffers.
#
# A `solana program deploy` that dies partway through — which the public devnet
# endpoint causes reliably, by rate-limiting the write transactions — leaves a
# buffer account holding the program's full rent. On devnet that is a couple of
# SOL of faucet funds stuck behind a failed command.
#
# This closes every buffer the payer owns and returns the lamports.

set -uo pipefail

export PATH="${HOME}/.local/share/solana/install/active_release/bin:${PATH}"

REPO="/mnt/c/Users/hp/Downloads/QUITTANCE"

RPC="$(grep -E '^HELIUS_RPC_URL=' "${REPO}/.env" | head -1 | cut -d= -f2- | tr -d '\r')"
if [ -n "${RPC}" ]; then
  solana config set --url "${RPC}" >/dev/null
else
  solana config set --url https://api.devnet.solana.com >/dev/null
fi

echo "  payer    $(solana address)"
echo "  before   $(solana balance)"
echo

echo "== buffers owned by this payer"
solana program show --buffers 2>&1 | tail -20

echo
echo "== closing all buffers"
solana program close --buffers --bypass-warning 2>&1 | tail -10

echo
echo "  after    $(solana balance)"

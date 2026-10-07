#!/usr/bin/env bash
#
# Deploy the program to devnet and record the evidence.
#
# The program keypair is fixed and gitignored, so the address in `declare_id!`,
# in `Anchor.toml`, in the IDL and on chain are all the same key. Redeploying
# upgrades in place rather than producing a second program with a second
# address, which matters because every claim in this repository points at one
# program id.

set -euo pipefail

export PATH="${HOME}/.avm/bin:${HOME}/.cargo/bin:${HOME}/.local/share/solana/install/active_release/bin:${PATH}"

REPO="/mnt/c/Users/hp/Downloads/QUITTANCE"
PROGRAM_DIR="${REPO}/program"
SO="${PROGRAM_DIR}/target/deploy/quittance.so"
PROGRAM_KEYPAIR="${PROGRAM_DIR}/keys/quittance-keypair.json"

if [ ! -f "${SO}" ]; then
  echo "  MISSING ${SO} — run the build first"
  exit 1
fi

# The RPC endpoint comes from .env.
#
# The public devnet endpoint rate-limits hard enough that a program deploy
# fails partway through with "Max retries exceeded", stranding a buffer
# account full of rent. Helius handles the write throughput, which is why the
# endpoint is required rather than optional.
RPC="$(grep -E '^HELIUS_RPC_URL=' "${REPO}/.env" | head -1 | cut -d= -f2- | tr -d '')"
if [ -z "${RPC}" ]; then
  echo "  HELIUS_RPC_URL is not set in .env. The public endpoint cannot carry a deploy."
  exit 1
fi
solana config set --url "${RPC}" >/dev/null
echo "  rpc        $(echo "${RPC}" | sed -E 's/api-key=[^&]*/api-key=<redacted>/')"

PAYER="$(solana address)"
PROGRAM_ID="$(solana address -k "${PROGRAM_KEYPAIR}")"
SIZE="$(stat -c%s "${SO}")"

echo "  payer      ${PAYER}"
echo "  balance    $(solana balance)"
echo "  program    ${PROGRAM_ID}"
echo "  size       ${SIZE} bytes"
echo "  rent       $(solana rent "${SIZE}" | tail -1)"
echo

echo "== deploying"
solana program deploy \
  --program-id "${PROGRAM_KEYPAIR}" \
  --keypair "${HOME}/.config/solana/id.json" \
  "${SO}"

echo
echo "== deployed"
solana program show "${PROGRAM_ID}"
echo
echo "  remaining  $(solana balance)"

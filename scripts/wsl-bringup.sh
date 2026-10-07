#!/usr/bin/env bash
#
# WSL side of the environment bring-up.
#
# The split is deliberate. Windows owns the phone and the Android toolchain,
# because that is where the USB device is. WSL owns Rust, the Solana CLI and
# Anchor, because `anchor build` targets SBF through a toolchain that is only
# reliably packaged for Linux. Nothing in this script touches the Windows side.
#
#   wsl.exe -d Ubuntu-24.04 -- bash /mnt/c/.../scripts/wsl-bringup.sh [--with-anchor]
#
# Idempotent: safe to re-run. It will not overwrite an existing keypair.

set -euo pipefail

REPO="/mnt/c/Users/hp/Downloads/QUITTANCE"
SOLANA_BIN="${HOME}/.local/share/solana/install/active_release/bin"
MARKER="# --- quittance toolchain ---"

say() { printf '  %s\n' "$*"; }
head2() { printf '\n== %s\n' "$*"; }

# ---------------------------------------------------------------------------
# PATH
#
# The binaries were already installed but only reachable from an interactive
# shell: `bash -lc` reads ~/.profile, and the installers had appended to
# ~/.bashrc alone. Written to both so a login shell, a non-login shell and a
# `wsl.exe --` invocation all agree.
# ---------------------------------------------------------------------------

head2 "PATH"
for rc in "${HOME}/.profile" "${HOME}/.bashrc"; do
  touch "${rc}"
  if grep -qF "${MARKER}" "${rc}"; then
    say "already configured: ${rc}"
  else
    {
      printf '\n%s\n' "${MARKER}"
      printf 'export PATH="$HOME/.cargo/bin:%s:$HOME/.avm/bin:$PATH"\n' "${SOLANA_BIN}"
    } >> "${rc}"
    say "configured: ${rc}"
  fi
done

export PATH="${HOME}/.cargo/bin:${SOLANA_BIN}:${HOME}/.avm/bin:${PATH}"

head2 "versions"
say "rustc    $(rustc --version 2>&1)"
say "cargo    $(cargo --version 2>&1)"
say "solana   $(solana --version 2>&1)"

# ---------------------------------------------------------------------------
# Keypairs
#
# The repository's `.keys/` is the single source of truth, so that the Windows
# harness and the WSL CLI sign as the same wallets. Copied into the CLI's
# default location rather than symlinked, because a symlink across /mnt/c
# confuses some Solana tooling about file permissions.
# ---------------------------------------------------------------------------

head2 "keypairs"
mkdir -p "${HOME}/.config/solana"

for pair in "payer.json:id.json" "adversary.json:adversary.json"; do
  src="${REPO}/.keys/${pair%%:*}"
  dst="${HOME}/.config/solana/${pair##*:}"
  if [ ! -f "${src}" ]; then
    say "MISSING ${src} — run: node scripts/keygen.mjs .keys/payer.json .keys/adversary.json"
    exit 1
  fi
  cp "${src}" "${dst}"
  chmod 600 "${dst}"
  say "installed ${dst}"
done

solana config set --url https://api.devnet.solana.com >/dev/null
say "cluster set to devnet"

PAYER="$(solana address)"
ADVERSARY="$(solana address -k "${HOME}/.config/solana/adversary.json")"

# ---------------------------------------------------------------------------
# Anchor
#
# Pinned to the version `program/programs/quittance/Cargo.toml` depends on.
# `avm install latest` would float, and a CLI a minor version ahead of the
# crate emits an IDL the client cannot parse.
# ---------------------------------------------------------------------------

ANCHOR_VERSION="0.31.1"

if [ "${1:-}" = "--with-anchor" ]; then
  head2 "anchor ${ANCHOR_VERSION}"

  if ! command -v apt-get >/dev/null; then
    say "no apt-get; skipping build dependencies"
  else
    say "installing build dependencies"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null 2>&1 || true
    apt-get install -y -qq build-essential pkg-config libssl-dev libudev-dev >/dev/null 2>&1 || \
      say "apt-get install reported a problem; continuing and letting cargo say what is missing"
  fi

  if command -v avm >/dev/null; then
    say "avm present: $(avm --version 2>&1)"
  else
    say "building avm from source (this takes a while)"
    cargo install --git https://github.com/solana-foundation/anchor avm --force --locked
  fi

  say "installing anchor ${ANCHOR_VERSION}"
  avm install "${ANCHOR_VERSION}"
  avm use "${ANCHOR_VERSION}"
  say "anchor   $(anchor --version 2>&1)"
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

head2 "fund these two addresses at https://faucet.solana.com (select Devnet)"
printf '\n'
printf '  PAYER      %s\n' "${PAYER}"
printf '  ADVERSARY  %s\n' "${ADVERSARY}"
printf '\n'

head2 "balances"
say "payer      $(solana balance "${PAYER}" 2>&1)"
say "adversary  $(solana balance "${ADVERSARY}" 2>&1)"
printf '\n'

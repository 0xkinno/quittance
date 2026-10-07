#!/usr/bin/env bash
#
# Install the SBF platform-tools into WSL's Solana cache from a local archive.
#
# `cargo-build-sbf` normally downloads this itself. On this machine its Rust
# HTTP client cannot resolve DNS inside WSL even though glibc can, so the
# archive is fetched on the Windows side and placed into the cache here. The
# result is identical: the same official Anza release at the same version, in
# the same location the toolchain looks for it.
#
#   wsl.exe -d Ubuntu-24.04 -- bash /mnt/c/.../scripts/wsl-install-sbf.sh
#
# Idempotent: re-running over a populated cache is a no-op.

set -euo pipefail

# The version cargo-build-sbf asks for depends on the Anchor CLI in use.
# Passed in rather than hardcoded so a toolchain bump is a one-word change.
VERSION="${1:-v1.48}"
REPO="/mnt/c/Users/hp/Downloads/QUITTANCE"
# v1.46.1 was fetched under the unversioned name; later versions are suffixed.
if [ -f "${REPO}/.cache/platform-tools-${VERSION}-linux-x86_64.tar.bz2" ]; then
  ARCHIVE="${REPO}/.cache/platform-tools-${VERSION}-linux-x86_64.tar.bz2"
else
  ARCHIVE="${REPO}/.cache/platform-tools-linux-x86_64.tar.bz2"
fi
CACHE="${HOME}/.cache/solana/${VERSION}"
TOOLS="${CACHE}/platform-tools"

say() { printf '  %s\n' "$*"; }

if [ ! -f "${ARCHIVE}" ]; then
  say "MISSING ${ARCHIVE} (version ${VERSION})"
  exit 1
fi

if [ -x "${TOOLS}/rust/bin/rustc" ]; then
  say "already installed: ${TOOLS}"
else
  mkdir -p "${TOOLS}"
  say "extracting $(du -h "${ARCHIVE}" | cut -f1) into ${TOOLS}"
  tar -xjf "${ARCHIVE}" -C "${TOOLS}"
  say "extracted"
fi

# cargo-build-sbf checks for the archive next to the extracted tree and skips
# the download when it is present.
if [ ! -f "${CACHE}/platform-tools-linux-x86_64.tar.bz2" ]; then
  cp "${ARCHIVE}" "${CACHE}/platform-tools-linux-x86_64.tar.bz2"
  say "download marker placed"
fi

printf '\n== contents\n'
ls "${TOOLS}" | head -8

printf '\n== toolchain\n'
if [ -x "${TOOLS}/rust/bin/rustc" ]; then
  say "sbf rustc  $("${TOOLS}/rust/bin/rustc" --version 2>&1)"
else
  say "sbf rustc  NOT FOUND at ${TOOLS}/rust/bin/rustc"
  exit 1
fi

# The SBF toolchain has to be registered with rustup under the name Anchor and
# cargo-build-sbf expect, or the build falls back to the host toolchain and
# emits an ELF the loader will not accept.
export PATH="${HOME}/.cargo/bin:${PATH}"
if rustup toolchain list 2>/dev/null | grep -q '^solana'; then
  say "rustup    solana toolchain already linked"
else
  rustup toolchain link solana "${TOOLS}/rust" 2>&1 && say "rustup    linked solana -> ${TOOLS}/rust"
fi

printf '\n'

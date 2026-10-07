#!/usr/bin/env bash
#
# Run an Anchor command against the program, from WSL.
#
#   wsl.exe -d Ubuntu-24.04 -- bash /mnt/c/.../scripts/wsl-anchor.sh build
#   wsl.exe -d Ubuntu-24.04 -- bash /mnt/c/.../scripts/wsl-anchor.sh deploy
#
# PATH is set explicitly rather than relying on a login shell, because
# `wsl.exe -- bash -lc` does not reliably source the profile when it is
# invoked from a Windows process launcher.

set -euo pipefail

export PATH="${HOME}/.avm/bin:${HOME}/.cargo/bin:${HOME}/.local/share/solana/install/active_release/bin:${PATH}"

PROGRAM_DIR="/mnt/c/Users/hp/Downloads/QUITTANCE/program"

# Anchor writes build output into `target/`, and building across the /mnt/c
# boundary is slow enough to matter on a deadline. CARGO_TARGET_DIR is kept on
# the Linux filesystem; the artifacts that matter are copied back afterwards.
export CARGO_TARGET_DIR="${HOME}/.quittance-target"

# The SBF toolchain version.
#
# Anchor 0.31.1 asks cargo-build-sbf for v1.48, whose cargo is 1.84 and cannot
# parse the edition-2024 manifests several transitive dependencies now ship.
# v1.57 carries rustc 1.95, which can.
#
# Passed as a flag to cargo-build-sbf rather than through SBF_TOOLS_VERSION:
# that environment variable also selects which Solana release the build uses,
# which is not the intent and silently changed the toolchain underneath.
SBF_TOOLS_VERSION="v1.57"

cd "${PROGRAM_DIR}"

echo "anchor   $(anchor --version 2>&1 | tail -1)"
echo "sbf      ${SBF_TOOLS_VERSION}"
echo "solana   $(solana --version 2>&1)"
echo "target   ${CARGO_TARGET_DIR}"
echo

if [ "${1:-}" = "build" ]; then
  shift

  # The program and the IDL are built separately, on purpose.
  #
  # `anchor build` runs two very different compilations: cargo-build-sbf for
  # the on-chain binary, and a host `cargo test` pass that extracts the IDL.
  # Anything after `--` is forwarded to both, so `--tools-version` reaches the
  # IDL pass as well and `cargo test` rejects it.
  #
  # Splitting them lets the SBF build use the pinned toolchain while the IDL
  # pass uses the host toolchain, which is where it belongs anyway.
  echo "== program (SBF, ${SBF_TOOLS_VERSION})"
  anchor build --no-idl "$@" -- --tools-version "${SBF_TOOLS_VERSION}"

  echo
  echo "== IDL (host toolchain)"
  anchor idl build --out "${PROGRAM_DIR}/target/idl/quittance.json"     --out-ts "${PROGRAM_DIR}/target/types/quittance.ts"
else
  anchor "$@"
fi

# Copy the artifacts Anchor's own tooling expects to find under the program
# directory, so `anchor deploy` and the TypeScript tests resolve them.
if [ -d "${CARGO_TARGET_DIR}/deploy" ]; then
  mkdir -p "${PROGRAM_DIR}/target/deploy" "${PROGRAM_DIR}/target/idl" "${PROGRAM_DIR}/target/types"
  cp -f "${CARGO_TARGET_DIR}/deploy/"*.so "${PROGRAM_DIR}/target/deploy/" 2>/dev/null || true
  cp -f "${CARGO_TARGET_DIR}/idl/"*.json "${PROGRAM_DIR}/target/idl/" 2>/dev/null || true
  cp -f "${CARGO_TARGET_DIR}/types/"*.ts "${PROGRAM_DIR}/target/types/" 2>/dev/null || true
  echo
  echo "artifacts:"
  ls -la "${PROGRAM_DIR}/target/deploy/" 2>/dev/null | tail -5
fi

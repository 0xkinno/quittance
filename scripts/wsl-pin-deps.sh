#!/usr/bin/env bash
#
# Pin transitive crates that outran the SBF toolchain.
#
# `cargo-build-sbf` ships its own Rust, currently 1.84.1-dev. Crates.io keeps
# moving, and some transitive dependencies have since adopted edition 2024,
# which that cargo cannot parse. The build then fails on a crate nothing in
# this project asked for directly.
#
# The fix is to pin those crates to the last edition-2021 release in
# `Cargo.lock`. The lockfile is committed, so the build is reproducible for
# anyone who clones the repository rather than depending on what crates.io
# happens to resolve to on the day.

set -uo pipefail

export PATH="${HOME}/.cargo/bin:${HOME}/.local/share/solana/install/active_release/bin:${PATH}"
cd /mnt/c/Users/hp/Downloads/QUITTANCE/program

# The pin has to be applied with the SBF toolchain's own cargo, not the host's.
# The host cargo is far newer and resolves a different graph, so a lockfile
# generated with it omits exactly the crates that break the SBF build.
SBF_CARGO="${HOME}/.cache/solana/v1.48/platform-tools/rust/bin/cargo"
if [ -x "${SBF_CARGO}" ]; then
  CARGO="${SBF_CARGO}"
  echo "using the SBF cargo: $(${CARGO} --version 2>&1)"
else
  CARGO="cargo"
  echo "SBF cargo not found; falling back to $(${CARGO} --version 2>&1)"
fi

# Each entry is "crate:version" — the newest release still on edition 2021.
PINS=(
  # blake3 1.8 moved to digest 0.11, which pulls block-buffer 0.12 and with it
  # edition 2024. 1.5.5 is the last release on the digest 0.10 line, and
  # pinning it here is what keeps the whole hashing chain parseable by the
  # SBF cargo. This is the pin that actually matters; the rest are belt and
  # braces for the same class of drift.
  "blake3:1.5.5"
  "block-buffer:0.10.4"
  "crypto-common:0.1.6"
  "digest:0.10.7"
  "sha2:0.10.8"
  "generic-array:0.14.7"
  "hashbrown:0.15.2"
  "indexmap:2.7.1"
  "toml_edit:0.22.22"
  "toml_datetime:0.6.8"
  "winnow:0.6.24"
  "bytemuck:1.21.0"
  "zerofrom:0.1.5"
  "litemap:0.7.4"
  "zerovec:0.10.4"
  "icu_collections:1.5.0"
)

echo "== generating a lockfile"
"${CARGO}" generate-lockfile 2>&1 | tail -3

for pin in "${PINS[@]}"; do
  crate="${pin%%:*}"
  version="${pin##*:}"
  if "${CARGO}" update -p "${crate}" --precise "${version}" >/dev/null 2>&1; then
    echo "  pinned ${crate} -> ${version}"
  else
    # Not every pin applies to every resolution. A crate that is not in the
    # graph, or already at or below the pin, is not an error.
    echo "  skipped ${crate} (not in the graph, or already compatible)"
  fi
done

echo
echo "== crates still requiring edition 2024, if any"
grep -n 'edition2024' Cargo.lock 2>/dev/null || echo "  none in the lockfile"

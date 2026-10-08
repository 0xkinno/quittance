# PROGRESS

The handoff document. Read this first when resuming work.

**Updated:** 2026-10-08
**State:** Mechanism proven · program deployed · engine, app and web shipped ·
release APK runs standalone on a physical device · live site deployed.
Remaining work is two *measurements* (E8 and the break campaign), not features.

---

## What is done

### Chain and mechanism
- **Program deployed to devnet** — `BXFpbaNWBy2ZJeQLE3bhRSSRfBqZgP3CVTtFoxCqyvFP`,
  7 instructions, 4 accounts, 24 error codes. I3 and I4 enforced on chain; I2
  enforced by a vault check the client cannot talk its way past.
- **Five devnet experiments, 5 of 5 passed** (`evidence/experiments.json`,
  nonce account `7v119bouZwmiGuhcbkuVZcQVs1xSqWzETTRJhQdwjASb`, 2026-10-05).
  E6b is the one that matters: invariant I1 demonstrated on a live cluster,
  enforced by the validator rather than by this code.

### Software
- **Engine** — 113 tests, zero network, zero React. Full verdict table, five
  ambiguity reasons, crash points at each write-ahead boundary, every invariant
  tested clean *and* against a deliberately corrupted store.
- **Verifier and harness** — built and typechecking; the baseline arm is written
  honestly rather than strawmanned.
- **Android app** — seven screens plus the E8/E7 probe, design tokens, MMKV
  write-ahead store, MWA integration. Typechecks clean (`tsc --noEmit`, exit 0).
  The wallet probe is reachable on-device from the home screen (*Wallet check (E8)*).
- **Release APK** — built with `./gradlew assembleRelease`, installed on a
  Samsung Galaxy A71 (Android 12) and confirmed running standalone with no dev
  server. Record in `EVIDENCE.md`.
- **Web** — landing page with an interactive eight-step judge demo, `/proof`,
  wallet connect, and an in-browser live check with two independent parts: the
  mechanism (a throwaway key signs the durable payment inside the tab; the
  visitor's wallet only funds it, and gets the SOL back) and an optional wallet
  test that compares what a wallet returns with what was built before sending.
  17 viewport assertions plus an 11-assertion Chromium end-to-end test against
  real devnet (`web/tests/live-check.e2e.mjs`).
- **Deployed** — Vercel, `https://quittance-inky.vercel.app`, public devnet RPC,
  non-sensitive `NEXT_PUBLIC_*` variables only.
- **Repository** — `https://github.com/0xkinno/quittance`, single author.

## Open items

| | Item | State |
|---|---|---|
| 1 | **Wallet handling of durable-nonce transactions** | Not confirmed on Solflare 2.29.1 (MWA) or Phantom (MWA); recorded in `LIMITATIONS.md` L8 and `EVIDENCE.md`. Our payment is valid (lands when signed locally; passes the Chromium end-to-end test). The live site's *Test my wallet* shows what any wallet does. Next measurement: a wallet other than these two, or a Seeker's built-in wallet. |
| 2 | **The break campaign** | `pnpm campaign` with a phone attached. Not run; no figure is stated anywhere. |

Nothing in the README depends on either. After a run, regenerate it so figures
come from `evidence/` and nowhere else: `node scripts/generate_readme.mjs`.

## The Android build — what it took

The failures were all toolchain, not code, and are kept here because the next
person will hit them:

1. `expo-modules-core` calls `useExpoPublishing()` whose `afterEvaluate` reads
   `components.release` before AGP registers it. Guarded; patch in `patches/`.
2. `local.properties` had `sdk.dir=C\:\Android`, which Java properties reads as
   `C:Android`. Now `C:/Android`.
3. Anchor 0.31.1 asks for SBF platform-tools v1.48, whose cargo cannot parse
   edition-2024 manifests. Pinned to v1.57.
4. The NDK (~1 GB) and Gradle distribution had to be fetched by hand; the Gradle
   zip is verified by SHA-256.
5. `app/` is deliberately not a pnpm workspace member (Expo autolinking breaks
   under pnpm's symlinks), so npm does not hoist some transitive modules.
   `expo-asset` and `bs58` are pinned as direct dependencies for that reason.
6. Metro does not honour package `exports` subpaths; a targeted resolver in
   `app/metro.config.js` maps
   `@solana-mobile/mobile-wallet-adapter-protocol/encoding`.
7. The probe screen existed but was never reachable from the app's route state;
   it is now, via a *Wallet check (E8)* link on the home screen.

## Deployment notes

Vercel's *Root Directory* is a dashboard-only setting and is `web`. The web
build runs `pnpm --filter web... run build` so the engine is built first, and
`.vercelignore` anchors its repo-root exclusions with a leading slash — an
unanchored `app/` once excluded `web/app/` and produced an empty deploy.

## Still needed from a human

| | |
|---|---|
| Campaign run | Phone attached; `pnpm campaign` |
| Demo video | Script and shot list in `docs/DEMO-SCRIPT.md` |
| Pitch deck | Attach to the portal submission |
| SKR devnet mint | Or confirmation it is mainnet-only; the lease uses a labelled stand-in until then |

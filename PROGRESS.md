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
  The probe is reachable on-device by long-pressing the circle name.
- **Release APK** — built with `./gradlew assembleRelease`, installed on a
  Samsung Galaxy A71 (Android 12) and confirmed running standalone with no dev
  server. Record in `EVIDENCE.md`.
- **Web** — landing page with an interactive eight-step judge demo, `/proof`,
  wallet connect, and an in-browser live check that runs the real mechanism with
  the visitor's wallet. 17 Playwright assertions across eight viewports.
- **Deployed** — Vercel, `https://quittance-inky.vercel.app`, public devnet RPC,
  non-sensitive `NEXT_PUBLIC_*` variables only.
- **Repository** — `https://github.com/0xkinno/quittance`, single author.

## What remains, and what it needs

Two measurements. Both need a human holding the phone because they involve a
wallet approval and physical fault injection.

| | Step | Needs |
|---|---|---|
| 1 | **E8 — the gate.** Long-press the circle name → *Run E8* → approve in the wallet. | Phone + Solflare on devnet with a little SOL |
| 2 | **The break campaign.** `pnpm campaign` | Phone attached over `adb`; run after E8 |

E8 goes first on purpose. If a wallet rewrites the transaction it was handed,
the nonce the app recorded is not the nonce the chain saw, every verdict
resolves to `AMBIGUOUS`, and the thesis changes. After a run, regenerate the
README so its figures come from `evidence/` and nowhere else:

```bash
node scripts/generate_readme.mjs
```

No document states a campaign number until that file exists.

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
   it is now, via long-press on the circle name.

## Deployment notes

Vercel's *Root Directory* is a dashboard-only setting and is `web`. The web
build runs `pnpm --filter web... run build` so the engine is built first, and
`.vercelignore` anchors its repo-root exclusions with a leading slash — an
unanchored `app/` once excluded `web/app/` and produced an empty deploy.

## Still needed from a human

| | |
|---|---|
| E8 and campaign run | Phone in hand — see above |
| Demo video | Script and shot list in `docs/DEMO-SCRIPT.md` |
| Pitch deck | Attach to the portal submission |
| SKR devnet mint | Or confirmation it is mainnet-only; the lease uses a labelled stand-in until then |

# TASK — Quittance

The authoritative phase and step breakdown. Every step is either done, blocked
on a named human-supplied item, or next. Nothing is marked done until the
artifact it produces exists in the repository.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

---

## Phase -1 — Toolchain and prerequisites

- [x] Audit the local toolchain and record what is present and what is missing
- [x] Repository layout created per Section 9
- [x] `.gitignore` written — `reference/` excluded from version control entirely
- [x] pnpm workspace, base TypeScript configuration
- [x] Document set created (Section 14)
- [x] Research set cloned into `reference/` (local study only)
- [x] JDK 17.0.13 LTS (Azul Zulu), build-tools 35.0.0, platforms android-35
- [x] Android platform-tools 37.0.1 (`adb` on PATH)
- [x] Physical Android device authorised (`adb devices` reports `device`)
- [x] Solana CLI 2.3.0 (WSL)
- [x] Anchor CLI 0.31.1 + SBF platform-tools v1.57 (WSL)
- [x] Funded devnet keypairs (payer + adversary)
- [x] Portal rules snapshot → `docs/rules-snapshot/`

## Phase 0 — Reproduce the discovery

**Run without a phone — complete.** These test what the Solana runtime does,
which is the part of the thesis this project does not implement and therefore
cannot get wrong.

- [x] E5 — deterministic verdict from one account read (devnet)
- [x] E5b — the nonce account is also the index: one pubkey recovers the consumer
- [x] E6a — ten identical rebroadcasts, exactly one transfer
- [x] E6b — a transaction against a consumed nonce is refused, `Blockhash not found`
- [x] E-R — a failed transfer still advances the nonce: processed is not paid
- [x] Runtime source citation: rollback-then-advance confirmed in Agave source
      (`docs/runtime-citations.md`, C1–C6)
- [x] Probe built into the app (`app/src/screens/ProbeScreen.tsx`) rather than a
      separate project, so one build serves both the E8 gate and the APK

**Blocked on the APK reaching the device.** Each of these drives the wallet or
force-stops the app, so none can run until the app is installed.

- [!] **E8 gate** — wallet does not rewrite the nonce as a recent blockhash
- [!] E7 — `getCapabilities` probe on each wallet
- [!] E1 — kill while wallet foreground, pre-approval
- [!] E2 — kill after approval, before session returns
- [!] E3 — naive retry after E2, count double transfers
- [!] E4 — blockhash recovery attempt after 120s
- [!] `DISCOVERY.md` — written once E8 settles; the five-point gate cannot be
      recorded honestly before then

## Phase A — Write-ahead intent store

- [x] `engine/src/types.ts` — states, verdicts, reasons, intents as types
- [x] `engine/src/canonical.ts` — canonical encoding and sha256 message hash
- [x] `engine/src/intent.ts` — intent record construction and validation
- [x] `engine/src/store.ts` — durable write-ahead store interface + memory impl
- [x] `engine/src/nonce-lease.ts` — pool provisioning, allocation, recycling
- [x] Crash-point tests between every pair of ordered steps
- [x] MMKV-backed store implementation in the app (`app/src/storage`)

## Phase B — Builder, broadcaster, verdict machine

- [x] `engine/src/builder.ts` — durable-nonce transaction construction
- [x] `engine/src/verdict.ts` — the pure verdict machine (Section 7)
- [x] `engine/src/broadcaster.ts` — bounded backoff, replay-safe by construction
- [x] `engine/src/resolver.ts` — walks non-terminal intents to terminal
- [x] `engine/src/invariants.ts` — I1–I6 as independent predicates
- [x] `engine/src/capabilities.ts` — wallet capability probe record
- [x] Verdict machine table tests: 6 outcomes, 5 ambiguity reasons, <1s, no network
- [x] Forced test of the path where `signTransactions` is unavailable

## Phase C — The Anchor program

- [x] `Circle`, `Round`, `ContributionSlot` account layouts
- [x] `create_circle`, `join_circle`, `open_round`, `record_contribution`,
      `close_round`, `disburse`
- [x] I3 enforced on chain: no disburse while any slot is non-terminal
- [x] I4 enforced on chain: disbursed flag checked and set atomically
- [x] Adversarial test: two concurrent `disburse` calls, exactly one succeeds
- [x] Deploy to devnet, record program ID and signature in `EVIDENCE.md`

## Phase D — Break campaign and offline verifier

- [x] `packages/verifier` — standalone CLI, recomputes every verdict
- [x] Verifier reports intent-hash failure and verdict divergence separately
- [x] `packages/harness` — fault driver over adb, two arms
- [x] Baseline arm implemented honestly: blockhash, retry once, history scan
- [x] Fault corpus F1–F10
- [x] `scripts/manifest.ts` — fingerprints every artifact a claim rests on
- [x] `SECURITY.md` — threat model, MWA boundary, Seed Vault assumptions
- [!] Campaign executed on real hardware → blocked on the APK, then on E8

## Phase E — The app

- [x] Design tokens, type scale, motion primitives (Section 12)
- [x] Circle screen — the twelve-row ledger
- [x] Pay screen — one amount, one button, one fingerprint
- [x] Recovering screen — the thesis made visible, resolves under two seconds
- [x] Collection day screen — organizer view, payout gated with a reason
- [x] Resolve screen — the ambiguity escalation, exactly two safe actions
- [x] Receipts screen — the quittance per contribution
- [x] Proof screen — campaign results, invariant checks, verifier command
- [x] **APK built** — `app/android/app/build/outputs/apk/debug/app-debug.apk`,
      141 MB debug build, all four ABIs
- [!] APK installed on the device — phone is currently disconnected

## Phase F — The web landing page

- [x] Next.js app, design tokens shared with the app
- [x] Seven landing sections in order (Section 12.8)
- [x] `/proof` route rendering `evidence/*.json` live
- [x] Hero artwork integrated at full bleed, no glyph overlap
- [x] Playwright viewport suite across all eight sizes — 26 assertions, now
      also covering broken images and unrendered SVG
- [x] Judge demo: the app's own screens as an eight-step walkthrough
- [x] Navigation bar
- [!] Vercel deployment → human account. The site builds and serves locally;
      `pnpm --filter @quittance/web run build && … run start` on :3000

## Phase G — Harden and ship

- [x] `scripts/generate_readme.mjs` — every number injected from `evidence/`
- [x] README per Section 13
- [x] `LIMITATIONS.md` complete and current
- [ ] Demo video — needs the APK on the device
- [ ] Pitch deck
- [x] dApp Store metadata — 512×512 icon generated, package `com.quittance.app`,
      release profile in `eas.json` producing an APK rather than a bundle

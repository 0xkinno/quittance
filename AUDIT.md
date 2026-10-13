# Audit path

Everything a judge needs to check the claims in this repository at a fixed
commit. Each step lists the command and the output a real run produced on
2026-10-13 (Node v24.14.1, pnpm 12.3.4, Windows 10). Nothing here needs a
wallet, a key or a device unless it says so.

## 1. Install and build

```bash
pnpm install --frozen-lockfile
pnpm --filter "./packages/*" run build
pnpm --filter "./packages/*" run typecheck
```

Expected: `engine`, `harness` and `verifier` build and typecheck with no
errors.

## 2. Engine tests

```bash
pnpm --filter @quittance/engine run test
```

Expected tail of the output:

```
ℹ tests 113
ℹ suites 27
ℹ pass 113
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

The verifier and harness packages ship no unit tests of their own. Their
behaviour is exercised through the engine suite and, once a campaign exists,
through `pnpm verify`.

## 3. The deployed program

| | |
|---|---|
| Program ID | `BXFpbaNWBy2ZJeQLE3bhRSSRfBqZgP3CVTtFoxCqyvFP` (devnet) |
| Deploy signature | `54s28Cjh5gNY32p3aAEDibKei6dwByrHDB8eQUwBjokRtqastR5RK8t2UDY28o9LURt29ydgq8ehmHzs9H3QGvaR` |
| Deployed in slot | 507776440 |
| Explorer | https://explorer.solana.com/address/BXFpbaNWBy2ZJeQLE3bhRSSRfBqZgP3CVTtFoxCqyvFP?cluster=devnet |

IDL summary, read from [`program/target/idl/quittance.json`](program/target/idl/quittance.json):
7 instructions, 4 accounts, 24 errors.

```bash
node -e "const i=require('./program/target/idl/quittance.json');console.log(i.address,i.instructions.length,i.accounts.length,i.errors.length)"
```

Expected: `BXFpbaNWBy2ZJeQLE3bhRSSRfBqZgP3CVTtFoxCqyvFP 7 4 24`

The Anchor build needs the Solana SBF toolchain and is not run in CI. The WSL
build steps are in [`scripts/wsl-anchor.sh`](scripts/wsl-anchor.sh) and
[`scripts/wsl-deploy.sh`](scripts/wsl-deploy.sh).

## 4. The mechanism experiments

```bash
node -e "const e=require('./evidence/experiments.json');console.log(e.results.map(r=>r.id+':'+r.passed).join(' '))"
```

Expected: `E5:true E5b:true E6a:true E6b:true E-R:true`

Each result carries the observed values and the transaction signatures it
rests on, so any of them can be checked on the explorer.

## 5. The web app

```bash
pnpm --filter @quittance/web run build
pnpm --filter @quittance/web run test
```

The second command runs the Playwright viewport suite (it installs nothing by
itself: run `pnpm --filter @quittance/web exec playwright install chromium` once). The
live deployment is https://quittance-inky.vercel.app.

## 6. The Android app

The release APK is built with `./gradlew assembleRelease`
([steps](docs/DEV-CLIENT.md)). Its SHA-256 is recorded in
[`EVIDENCE.md`](EVIDENCE.md). Verify a downloaded copy:

```bash
sha256sum app-release.apk
```

## 7. What is not here yet

Stated so no one has to hunt for it, and repeated in
[`LIMITATIONS.md`](LIMITATIONS.md):

- The fault campaign has not been run, so `evidence/campaign.json`,
  `evidence/intents.jsonl` and a verifier log do not exist and no campaign
  figure is claimed.
- E8, the wallet pass-through check, is unmeasured on every wallet tried.
  Solflare showed a network mismatch and Phantom's authorization failed on a
  durable-nonce transaction; the attempts are logged in `EVIDENCE.md`.
- The SKR lease uses a labelled stand-in mint on devnet.
- Devnet only, unaudited.

## 8. Evidence files

| File | Contents |
|---|---|
| [`EVIDENCE.md`](EVIDENCE.md) | Deployments, device fingerprints, APK hash, E7/E8 attempt log |
| [`evidence/experiments.json`](evidence/experiments.json) | Machine-readable results of the five devnet experiments |
| [`LIMITATIONS.md`](LIMITATIONS.md) | Every known gap |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Design and the six invariants |
| [`SECURITY.md`](SECURITY.md) | Security model |
| [`PROGRESS.md`](PROGRESS.md) and [`MILESTONES.md`](MILESTONES.md) | Build history |

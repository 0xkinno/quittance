# Installing the app on a device

The exact steps, and what each one is for. Everything here has been run on the
device recorded in `EVIDENCE.md`; nothing is from memory.

---

## What you need once

All of it installs without administrator rights. `winget` on the build machine
reports *"the file cannot be accessed by the system"* — a broken App Installer
alias — so every tool below is a plain archive extracted into `C:\Android`.

| Tool | Version | Installed by |
|---|---|---|
| JDK | 17.0.13 LTS (Azul Zulu) | `scripts/fetch-android-toolchain.ps1` |
| Android SDK platform-tools | 37.0.1 | same |
| Android SDK build-tools | 35.0.0 | `sdkmanager` |
| Android platform | android-35 | `sdkmanager` |
| Node | 20+ | — |
| pnpm | 12+ | — |

```powershell
powershell -ExecutionPolicy Bypass -File scripts/fetch-android-toolchain.ps1
```

It sets `JAVA_HOME`, `ANDROID_HOME` and `PATH` for your user. **Open a new
terminal afterwards** so the variables are picked up.

SDK licences are accepted by writing the published hash files into
`C:\Android\licenses`, which is the documented headless equivalent of the
interactive prompt. The licence text is identical either way.

---

## Connecting the phone

### 1. Turn on USB debugging

- **Settings → About phone → Software information →** tap **Build number**
  seven times.
- **Settings → Developer options → USB debugging →** on.
- Connect by USB and set the connection to **File transfer / MTP**, not USB
  tethering. In tethering mode the ADB interface is not exposed at all and
  `adb devices` stays empty.

### 2. If `adb devices` says `unauthorized`

This means debugging is on and the key handshake is stuck. The phone is
holding a stale authorization and will not re-prompt.

```bash
adb devices
# RZ8N12CFEJN   unauthorized
```

**Wireless pairing is the reliable fix**, and it also authorises the USB
transport because both use the same key:

- **Settings → Developer options → Wireless debugging →** on
- **Pair device with pairing code** — note the **IP:port** and the six-digit
  code

```bash
adb mdns services          # find the live pairing port
adb pair 192.168.x.x:PORT CODE
adb kill-server && adb start-server
adb devices                # now reports: device
```

**The pairing port changes every time that dialog is reopened.** Reading it
off the screen and then reopening the dialog for a fresh code gives you a
stale port and `protocol fault (couldn't read status message)`. Always take
the port from `adb mdns services` rather than from the screen.

Pairing persists across reboots and replugs, so this is a one-time step.

### 3. Install Solflare and switch it to Devnet

From the Play Store. Create or import a wallet, then **Settings → Network →
Devnet**. Experiment E7 records which signing methods it actually implements;
E8 tests whether it preserves a durable nonce.

---

## Building and installing

### The app installs with npm, not pnpm

`app/` is deliberately **not** a pnpm workspace package, and this is the single
most important thing to know before touching the Android build.

Expo's Android autolinking generates a Gradle project per native module and
resolves their paths by walking `node_modules`. Under pnpm's symlinked layout
those projects configure with no variants at all and the build dies with:

```
No matching variant of project :solana-mobile_mobile-wallet-adapter-protocol
was found ... but: - No variants exist.
```

Hoisting the whole workspace fixes Expo and breaks the web package, because
Expo SDK 52 needs React 18 while Next 15's App Router needs React 19 — one
tree cannot hold both. So the app keeps its own flat `npm install` and consumes
the engine over a `file:` dependency.

```bash
# build the engine first: the app consumes its dist/ over file:
pnpm --filter @quittance/engine run build

cd app
npm install
npx expo prebuild --platform android --clean
```

`prebuild` generates `android/` from `app.json` and `app.config.js`. It is
regenerated rather than edited, so nothing in `android/` is committed.

```bash
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The first `gradlew` run downloads the Gradle distribution (~130 MB) and the
Android Gradle Plugin, so it takes several minutes. Later runs are fast.

### The release APK

```bash
cd android
./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`.

For a submission build with EAS instead:

```bash
cd app
eas build --platform android --profile preview
```

`eas.json` sets `buildType: apk` on the preview profile, because the
submission requires an installable APK rather than an app bundle.

---

## `.env` reaches the build through `app.config.js`

The RPC endpoint is read from the repository's `.env` at build time and
injected into `expo.extra`. It is never committed.

A build with no `.env` falls back to the public devnet endpoint. That works
for clicking around and **not** for anything that produces a number, because
it rate-limits badly enough to distort timings — which is why
`scripts/check-env.mjs` refuses it.

---

## Running the experiments

The app carries a probe screen that runs E7 and E8 against whatever wallet is
installed.

E8 is the gate. It builds a durable nonce transaction, records the compiled
message hash **before** the wallet is opened, hands it over, then reads back
from the chain what the cluster actually received and compares the two. A
wallet cannot pass it by reporting success — the comparison is against bytes
the chain returned.

If E8 fails, the wallet rewrote the transaction, and Quittance will not
collect through it.

The experiments that need no phone and no wallet run from Node:

```bash
node scripts/experiment-nonce.mjs
```

That covers E5, E6 and the rollback-then-advance behaviour, writing
`evidence/experiments.json`.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `adb devices` empty, phone plugged in | USB mode is tethering, not File transfer |
| `unauthorized`, no prompt appears | Stale key state — use wireless pairing above |
| `protocol fault` when pairing | The pairing port is stale; take it from `adb mdns services` |
| `SDK location not found` | `android/local.properties` missing — prebuild regenerates it, or write `sdk.dir=C\:\\Android` |
| `Unsupported class file major version` | Wrong JDK. Gradle needs 17; check `java -version` |
| `No variants exist` for a native module | The app was installed with pnpm. Use `npm install` inside `app/` |
| `Could not get unknown property 'release'` | `expo-modules-core`'s publishing block. Apply the guard in `patches/` |
| `The filename, directory name, or volume label syntax is incorrect` | `android/local.properties` has a bad escape. Use `sdk.dir=C:/Android` |
| `feature edition2024 is required` | SBF toolchain too old. `scripts/wsl-anchor.sh` pins platform-tools v1.57 |
| NDK download stalls | `sdkmanager --sdk_root=C:\Android "ndk;26.1.10909125"` separately; it is ~1 GB |

## What had to be worked around, and why

Recorded because every one of these cost real time and none of them is obvious
from the error message.

| Problem | Cause | Fix |
|---|---|---|
| `No variants exist` for every native module | Expo autolinking vs pnpm symlinks | `app/` left out of the workspace, installed with npm |
| `Could not get unknown property 'release'` | `expo-modules-core` publishes to mavenLocal in an `afterEvaluate` that runs before AGP registers the component | Guarded behind a property; patch in `patches/` |
| `volume label syntax is incorrect` | `sdk.dir=C\:\Android` — Java properties reads the single backslash as an escape, giving `C:Android` | `sdk.dir=C:/Android` |
| `feature edition2024 is required` | Anchor 0.31.1 requests SBF platform-tools v1.48, whose cargo is 1.84 | Pinned to v1.57 (rustc 1.95) |
| Gradle distribution corrupt | A resumed download on a lossy link appended duplicate bytes | Fetched fresh, verified by SHA-256 before use |

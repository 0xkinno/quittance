# LIMITATIONS

Every substitution, every stand-in, and every `UNKNOWN`, stated against the
specific claim it affects. This section is written before the roadmap because
it buys more credibility than any feature.

**Updated:** 2026-10-08

---

## L1 — The SKR lease is a purchase, not a stake

**Affects:** nothing in the guarantee. Recorded because the design changed
after the rules were read, and the reason should be on the record.

The portal's FAQ states, verbatim:

> (SKR Staking Integrations do not qualify)

The nonce lease was originally specified with the circle organizer **staking**
SKR to open it. That is excluded. The lease now works by **purchase**: the
organizer spends SKR once to provision the circle's pool of rent-exempt nonce
accounts.

The mechanism is unchanged and so is the argument for it — without the lease
every member would have to fund a rent-exempt account before paying a weekly
contribution, which removes the product. What changed is that the SKR is
spent rather than locked. There is no position to unwind, no unbonding, and
nothing for the circle to withdraw later.

That distinction is what makes it a utility integration rather than a staking
one: SKR buys the thing that makes the guarantee affordable, and the circle
holds no position in it afterwards.

Captured in `docs/rules-snapshot/rules.md` on 2026-10-05.

## L2 — The SKR mint is a stand-in

**Affects:** any claim that the nonce lease runs against SKR.

`SKR_MINT` is unset, so the lease runs against a stand-in SPL mint. This is
surfaced, not hidden:

- the engine carries `mintIsGenuineSkr: false` on every lease;
- the app renders a labelled notice wherever the lease is shown;
- `scripts/check-env.mjs` prints `SKR mint: stand-in (labelled everywhere)`.

The real SKR devnet mint address has not been confirmed. Until it is, nothing
in this build claims an SKR integration against the real asset.

## L3 — `TRANSACTION_UNAVAILABLE` is a fifth ambiguity reason

**Affects:** the completeness of the four enumerated ambiguity reasons.

The specification enumerates four. A fifth real case exists: the nonce has
advanced, a signature exists, and the node will not return the transaction, so
the message hash cannot be compared. Calling that settled would violate I2;
calling it not-sent would violate I1. It escalates under its own named reason
rather than being folded into one of the four.

## L4 — A `SETTLED` verdict may be uncorroborated

**Affects:** the strength of I2 on individual slots, never its direction.

I2 requires a hash-matched success **and** an agreeing balance delta. When a
node returns no token balances for a transaction, the balance check cannot
run. The verdict is still `SETTLED` — the transaction is provably the recorded
one and provably succeeded — but it carries `i2Corroborated: false`, and the
verifier reports those on a separate line rather than counting them as a clean
pass. The machine never reports a check that did not run.

## L5 — The program does not re-derive verdicts

**Affects:** what the on-chain program can be said to guarantee.

A Solana program cannot read arbitrary transaction history, so it cannot
inspect a durable nonce account's signatures and decide for itself whether a
payment landed. `record_contribution` therefore takes the slot's state as an
argument.

What the program *does* enforce, and what it does not, is set out in
`SECURITY.md`. In short: it will not credit a settlement unless the vault's own
balance already covers it, so a phantom credit is impossible on chain; it does
not independently distinguish `REJECTED` from `NOT_SENT`, and neither of those
credits anything. The nonce account is stored on chain precisely so a stranger
can re-derive every verdict from chain state alone.

## L6 — The design brief's `--ink-faint` fails WCAG AA

**Affects:** nothing structural. Recorded because a specified value was
changed.

Section 12.2 specifies `--ink-faint: #8E959C`. Measured against the three
paper grounds it reaches 2.25–2.77:1, where AA requires 4.5:1 for the text it
carries — section labels, the "not paid" state mark, the program id. Section
12.6 of the same brief requires AA.

It is now `#5A6168`, the lightest value that clears 4.5:1 on `--paper-sunk`,
the darkest ground it sits on. That is close to `--ink-soft`, which is the
honest outcome: on paper this light, a third *text* tier below `--ink-soft`
cannot pass AA at all.

Caught by `web/tests/viewports.spec.ts`, which measures every text node against
its own computed background rather than an assumed page colour.

## L7 — The resolution diagram is drawn, not typeset

**Affects:** nothing. Recorded as a deliberate deviation.

Section 12.8 asks for the Section 11 ASCII diagram typeset in Geist Mono on
`--paper-sunk`. It is drawn as inline SVG instead: it scales to any column
width without horizontal scrolling, carries the state palette so the diagram
teaches the legend the ledger then uses, and is readable by a screen reader
through a title and description. The ASCII form is kept verbatim in the README,
where a monospace block is the right medium.

## L8 — Wallet handling of durable-nonce transactions is not confirmed

**Affects:** the one step of the design that depends on a wallet.

Quittance's chain-side claims do not depend on any wallet: they are properties
of the Solana runtime, measured in the five devnet experiments and re-run live
in the browser. The step that does depend on a wallet is the user's approval of
a durable-nonce payment, and on the wallets tried that step did not complete:

| Date | Wallet and path | What happened |
|---|---|---|
| 2026-10-08 | Solflare 2.29.1, Mobile Wallet Adapter, on-device probe | The app built and hashed the payment, then Solflare showed *Network mismatch — current network is devnet, this transaction is for mainnet* with no approve option; the session ended in `CancellationException`. Repeated, including with a 25-second wait for the wallet's RPC to see the new account. Nothing was broadcast. |
| 2026-10-08 | Phantom, Mobile Wallet Adapter, on-device probe | The session failed at authorization (`-1/authorization request failed`) before any transaction. |
| 2026-10-08 | A desktop-browser wallet on devnet, live check (earlier version) | The wallet-signed durable-nonce payment failed at send with `Blockhash not found`. |

What is established, and what is not:

- **Our payment is valid.** Signed locally, the identical payment (nonce value as
  the blockhash, `AdvanceNonce` first, self-transfer) lands on devnet on both
  the public and Helius endpoints, and the live check's end-to-end test passes in
  Chromium against real devnet with a faithful wallet.
- **A wallet that alters the transaction is caught before anything is sent.** The
  live check's wallet test compares the message the wallet returns with the
  message that was built, and the end-to-end test asserts this with a wallet that
  deliberately rewrites the blockhash.
- **The cause on the real wallets is not determined.** The Solflare warning is
  consistent with a network heuristic that does not recognise a nonce value as a
  valid blockhash for the selected cluster; that is a hypothesis, not a finding.
  The browser failure could be the wallet replacing the blockhash or a state
  difference at simulation. The site's *Test my wallet* distinguishes these for
  any wallet.
- **Consequence for the product.** On the wallets tried, a member could not
  complete a durable-nonce payment. That is a compatibility risk for the
  wallet-dependent step, stated here rather than worked around, and it is why the
  live check isolates the mechanism from the wallet.

The fault campaign (`pnpm campaign`) has not been run, and no document states a
campaign figure.

## L9 — The release APK is signed with the debug keystore

**Affects:** distribution, not behaviour.

Expo's generated Android project signs `release` with the debug keystore. The
APK installs and runs identically, which is what review needs. A production or
dApp Store release needs its own upload key; that is a one-time step recorded
in the roadmap rather than something to improvise before a deadline.

## L10 — Scope of the evidence

**Affects:** how far any single result generalises.

- **Devnet only.** Every on-chain result is against devnet. The runtime
  behaviours measured (nonce rollback-then-advance, replay refusal) are
  properties of the validator and are not cluster-specific, but they were
  measured here.
- **One reference device.** The device of record is a Samsung Galaxy A71 on
  Android 12. Android's process-kill policy varies by vendor; other devices may
  kill a backgrounded app more or less aggressively.
- **One reference wallet** for E8 (Solflare). A different wallet may behave
  differently, which is exactly why E8 records the wallet and version.
- **Not audited.** The program and engine have been tested and checked against
  six invariants, not independently audited.

## L11 — The web demo runs on the public devnet RPC

**Affects:** latency and rate limits of the in-browser live check.

The deployed site deliberately carries no API key: it talks to the public
devnet endpoint. That keeps the bundle free of secrets and is why the live check
polls for confirmation rather than subscribing, but the public endpoint can
rate-limit under load. Re-running the check is safe — every run creates a fresh
nonce account.

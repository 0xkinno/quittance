# ARCHITECTURE

> The phone records intent. The chain decides truth. The phone is never
> allowed to be the authority on whether money moved.

Every component below exists to prove that sentence from a different angle.
If a component could decide whether a payment happened, it would be in the
wrong place.

---

## The shape of it

```
            INTENT                 EFFECT                  TRUTH
          (the phone)            (the wallet)            (the chain)

   allocate nonce ──┐
   read value N ────┤
   build tx ────────┤
   hash message ────┤
   WRITE + FSYNC ───┘──── signAndSendTransactions ────▶ nonce advances
                              │                              │
                        [ process killed ]                   │
                              │                              │
                              ▼                              ▼
                        no signature                   one account holds
                        no bytes                       the entire answer
                              │                              │
                              └──────── read nonce ──────────┘
                                             │
                        unchanged ───────────┴─────────── advanced
                             │                                │
                         NOT_SENT                   match? ───┴─── no match
                       rebroadcast                     │            │
                      (runtime drops                SETTLED      AMBIGUOUS
                       duplicates)                 / REJECTED    escalate
```

## Packages

```
program/            Anchor program — circle, round, contribution slots, payout
packages/
  engine/           THE MECHANISM. Pure TypeScript, zero React, zero RN.
  verifier/         Standalone Node CLI. Recomputes every verdict from an
                    exported intent log plus chain. No app, no wallet.
  harness/          Fault-injection campaign driver over adb. Two arms.
app/                React Native (Expo). The Seeker app — ships as a standalone release APK.
web/                Next.js. Landing page and the public /proof route.
evidence/           Generated JSON. Never hand-edited.
scripts/            Environment, experiments, manifest, README generation.
docs/               Runtime citations, rules snapshot.
```

### The engine has no dependency on React or React Native

This is a structural constraint, not a preference. The engine is imported
unchanged by the app, the verifier and the harness, and it is verified to load
and run under plain Node against `MemoryIntentStore`.

If it could not do that, invariant I6 would degrade from "every verdict is
deterministically recomputable" into "two codebases happen to agree", which is
a much weaker claim and one that rots silently.

## The engine's public contract

| Module | Responsibility | May touch the network |
|---|---|---|
| `types.ts` | Six states, five named ambiguity reasons | no |
| `canonical.ts` | The two hashes, deliberately separate | no |
| `intent.ts` | Write-ahead record construction | no |
| `builder.ts` | Durable-nonce transactions, advance-first enforced | no |
| `capabilities.ts` | MWA capability probe | no |
| `nonce-lease.ts` | The SKR-funded pool | no |
| `store.ts` | The write-ahead contract | no (durable storage) |
| `chain.ts` | Snapshot assembly | **yes — the only one** |
| `verdict.ts` | The pure verdict machine | no |
| `broadcaster.ts` | Send and rebroadcast | yes, through injected interfaces |
| `resolver.ts` | Orchestration | through `chain.ts` only |
| `invariants.ts` | I1–I6 as independent predicates | no |

`chain.ts` being the single network boundary is what makes `verdict.ts`
testable without a network, identical in the app and the verifier, and
impossible to accidentally make dependent on a live cluster.

### The two hashes, and why they are separate

| Hash | Over | Answers |
|---|---|---|
| `hashCompiledMessage` | the compiled transaction message bytes | "is the transaction that consumed my nonce the one I built?" |
| `hashIntentRecord` | a canonical serialization of the stored record | "has the stored intent been edited since it was written?" |

Conflating them would leave the verifier unable to say **which** of the two
went wrong. It reports `INTENT_HASH_FAILURE` and `VERDICT_DIVERGENCE` as
separate findings for exactly this reason.

The message hash excludes signatures deliberately: under the mandatory MWA 2.0
path the app never holds the signature at all, so the message is the only part
of the transaction it can commit to in advance.

The intent hash excludes `signedTransactionBase64` and `walletCapabilities`
deliberately: both depend on which wallet happens to be installed, and
including them would raise tamper alarms that are not tampering.

## The write-ahead sequence

```
1. allocate a nonce account from the lease
2. read its current nonce value N
3. build the transaction: AdvanceNonceAccount first, then the transfer
4. compute sha256 of the compiled message
5. WRITE the intent record and flush          <- the transaction boundary
6. only now call signAndSendTransactions
```

Die before step 5 and nothing was built and nothing was sent. Die at any point
from step 5 onward and the stored record carries the nonce account, the value
it was built against, the message hash and the message itself — everything the
resolver needs.

There is no window in between, and that is the property the whole design
preserves. `assertPersistedBeforeSend` makes it a runtime check rather than a
comment somebody will eventually move, and `test/store.crash.test.ts` kills
the process at each boundary and asserts what survives.

The device implementation uses MMKV because its writes are synchronous and
flushed before the call returns. An `AsyncStorage`-backed store would satisfy
the TypeScript interface and silently break the guarantee.

## The verdict machine

Five steps, matching `decidedAtStep` on every verdict so each row in the
evidence log says which test produced it.

| Step | Test | Outcomes |
|---|---|---|
| 1 | Does the nonce account exist, and has its value changed? | `AMBIGUOUS/NONCE_ACCOUNT_GONE`, `NOT_SENT` |
| 2 | Which signature consumed the nonce? | `AMBIGUOUS/BEYOND_RETENTION`, `AMBIGUOUS/TRANSACTION_UNAVAILABLE` |
| 3 | Recompute the message hash from chain data | `AMBIGUOUS/FOREIGN_CONSUMER` |
| 4 | Did it error? | `REJECTED` |
| 5 | Does the destination delta agree? | `AMBIGUOUS/BALANCE_DISAGREES`, `SETTLED` |

Four properties are enforced by construction rather than convention:

1. **It never guesses.** `AMBIGUOUS` is a first-class shippable outcome with a
   named reason.
2. **It is pure.** No network, no clock of its own — the observation time
   arrives inside the snapshot.
3. **`NOT_SENT` permits rebroadcast of the recorded bytes only.** It never
   authorizes rebuilding against a fresh nonce.
4. **No state moves backwards out of a terminal state.**
   `assertNoRegression` throws rather than writing a regression.

### Why step 2 is more subtle than it looks

The nonce value was read at `builtAtChainSlot` and stayed that value until
something advanced it, so the consumer is the *first* signature at or after
that slot.

There is one strengthening. A transaction whose message hashes to the recorded
hash is proof on its own that the recorded transaction was processed, because
the recorded nonce value is a field inside that message and the runtime admits
a nonce transaction only while the stored nonce equals that field. So if any
candidate matches the hash, it is definitively the consumer regardless of
ordering races in the slot bound.

## Where each invariant is enforced

| | Invariant | Enforced by |
|---|---|---|
| I1 | Exactly-once debit | **The Solana runtime.** A rebroadcast after the nonce advanced fails validation and is dropped before execution. |
| I2 | No phantom credit | **The program.** `record_contribution` will not credit a settlement the vault's own balance does not already cover. |
| I3 | Terminal before payout | **The program**, checked in `close_round` and again in `disburse`. |
| I4 | Single disbursement | **The program.** Flag checked and set in the same instruction as the transfer. |
| I5 | Honest ambiguity | The verdict machine, and the verifier re-checks it. |
| I6 | Offline determinism | The verifier, recomputing from the log plus chain. |

I1 is the strongest claim precisely because it is not ours. We did not write
that guarantee and we cannot get it wrong. Confirmed in validator source at
`docs/runtime-citations.md` C1–C6, and demonstrated against devnet in
`evidence/experiments.json`.

## What the program is not responsible for

A Solana program cannot read arbitrary transaction history, so it cannot
inspect a nonce account's signatures and derive a verdict. That decision is
made off chain by a pure function anyone can re-run.

The program stores the nonce account pubkey on chain for every slot, which is
what lets a stranger re-derive every verdict from chain state alone with no
access to the app, the phone, or any key. `SECURITY.md` sets out what a
malicious client can and cannot achieve through this seam.

## The nonce lease

Every contribution slot needs its own rent-exempt nonce account. Asking a
market trader to fund one before she can pay her weekly contribution does not
reduce the product's appeal, it removes the product.

So the circle organizer **buys** a lease with SKR, once, and the lease
pre-provisions a rotating pool: no member ever funds an account, no payment
blocks on account creation, and accounts are recycled between rounds by
advancing them, so rent is paid once for the life of the circle rather than
once per payment.

The SKR is spent, not locked. There is no position to unwind and nothing for
the circle to withdraw later, which is what makes it a utility integration
rather than a staking one.

Two runtime facts shape this module:

- A consumed nonce must be advanced before reuse, or every transaction built
  against it fails validation. Hence `AWAITING_RECYCLE` rather than returning
  straight to `AVAILABLE`.
- A nonce account advances **at most once per slot**
  (`docs/runtime-citations.md` C5). Recycling and reissue are therefore
  slot-aware and decline an advance they know will be rejected.

## The verifier

```bash
node packages/verifier/dist/cli.js \
  --intents evidence/intents.jsonl \
  --rpc $HELIUS_RPC_URL \
  --check I1,I2,I3,I4,I5,I6
```

It imports the engine's verdict machine and invariant predicates rather than
reimplementing them. What makes it independent is not a second implementation
— two implementations that drift give you an agreement test, not a determinism
test. It is that the **inputs** are independent: it re-reads the chain itself,
builds its own snapshots, recomputes the intent digests, and needs no app, no
wallet, no device and no key.

Exit code is 0 only when every check passes, so it can sit in CI.

## The harness

Two arms over one fault corpus on one device, never pooled.

The baseline is the standard mobile pattern written honestly: recent
blockhash, `signAndSendTransactions`, one retry after reconnecting, and a
history scan on recovery. It is not tuned to lose. Its structural limit is a
property of the approach rather than of the code — a history scan cannot
distinguish one member's payment from another's when the contribution amount
is fixed, and it collapses entirely with more than one payment pending.

## Deployment topology

| Surface | Where it runs | Notes |
|---|---|---|
| Program | Solana devnet, `BXFpbaNWBy2ZJeQLE3bhRSSRfBqZgP3CVTtFoxCqyvFP` | Upgrade authority held by the deployer; see `EVIDENCE.md` |
| Android app | A physical device, as a standalone release APK | JS is bundled into the APK at build time — no Metro, no dev server, no network requirement to launch |
| Web (landing, judge demo, `/proof`) | Vercel, `quittance-inky.vercel.app` | Static prerender; reads `evidence/` at build time, so every number on the page is the number in the results file |
| Verifier / harness | Developer machine | The verifier needs only an RPC URL; the harness needs `adb` and a device |

Configuration crosses each boundary through environment variables only:
`HELIUS_RPC_URL` (secret, build-time, app and scripts only) and the
`NEXT_PUBLIC_*` family (public by design, web only). The web bundle never
contains an RPC key — it talks to the public devnet endpoint.

## One engine, three consumers

`packages/engine` has no React and no network inside the verdict machine, which
is what lets the same code run in three places:

1. **The app** — creates intents, writes them ahead, and resolves on reopen.
2. **The verifier** — recomputes every verdict offline from the exported log.
3. **The browser** — the "Prove it yourself" section on the landing page runs a
   real durable-nonce round trip with the visitor's own wallet using the
   identical hashing and comparison functions.

A bug in the engine is therefore a bug in all three, and a test against the
engine is a test of all three.

## Reaching the wallet gate on a device

`ProbeScreen` (E7 capability probe and E8 gate) is wired into the app's route
state. It is reached by long-pressing the circle name on the home screen —
deliberately not a visible button, because the home screen's design contract is
one button and no blockchain vocabulary. It creates its own nonce account owned
by the member, so it needs no funded service key and anyone can reproduce it.

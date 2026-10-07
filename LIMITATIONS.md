# LIMITATIONS

Every substitution, every stand-in, and every `UNKNOWN`, stated against the
specific claim it affects. This section is written before the roadmap because
it buys more credibility than any feature.

**Updated:** 2026-10-05

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

## L8 — Not yet proven

These are not limitations of the design. They are statements that the evidence
does not exist yet, recorded so that nothing in this repository reads as though
it does.

| Claim | Status | Settled by |
|---|---|---|
| A compliant wallet preserves the durable nonce rather than substituting a recent blockhash | `UNKNOWN` | Experiment E8 — the gate |
| Which signing methods each wallet actually implements | `UNKNOWN` | Experiment E7 |
| Android kills the dApp during the wallet handoff often enough to matter | `UNKNOWN` | Experiments E1–E5 |
| The campaign's headline numbers | **do not exist** | The break campaign, once the device is attached |

No document in this repository states a campaign number, and none will until a
script has produced it from a real results file.

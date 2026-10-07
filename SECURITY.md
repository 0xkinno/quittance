# SECURITY

The threat model, stated against the specific guarantee Quittance makes:

> A member is never debited twice for one contribution, and a contribution is
> never counted as paid unless it was.

This document says what enforces that, what does not, and what an attacker in
each position can and cannot achieve. Where a seam exists, it is named rather
than described around.

---

## 1. The trust boundaries

There are five parties and they are trusted to different degrees.

| Party | Trusted for | Not trusted for |
|---|---|---|
| **The Solana runtime** | Replay rejection, nonce advance semantics, atomic instruction execution | — |
| **Seed Vault / the signing key** | Holding the member's key and signing only with their consent | — |
| **The wallet** | Broadcasting what it was given | Reporting what it did, preserving the message it was given |
| **The Quittance program** | Payout ordering and single disbursement | Deciding whether a payment happened |
| **The phone** | Recording intent | **Deciding whether money moved** |

The last row is the whole design. The phone is the least trusted component in
a system that runs on the phone.

## 2. What enforces the guarantee

### I1, exactly-once debit — enforced by the validator

This is the strongest claim in the project, and it is not ours.

A durable nonce transaction validates only while the nonce account's stored
value equals the value in the transaction's blockhash field, and processing
the transaction advances that account **before** execution
(`docs/runtime-citations.md`, C2). A second broadcast of identical bytes fails
`verify_nonce_account` and is rejected with `BlockhashNotFound` before any
instruction runs.

So Quittance's retry loop can be dumb, unbounded, and buggy, and it still
cannot double-charge. We did not write that guarantee and we cannot get it
wrong.

**What this does not cover.** The runtime can only reject a transaction it has
seen. If the client built a *second, different* transaction against a fresh
nonce while the first was still live, both would be valid and both could land.
That is the one way I1 could break, and it is why `NOT_SENT` is the only
verdict that authorizes resending, why it authorizes resending the **recorded
bytes only**, and why the reissue path advances the old nonce and waits for
that advance to confirm before building a replacement.

### I2, no phantom credit — enforced on chain, not by the client

`record_contribution` will not credit a slot as settled unless the vault's own
token balance already covers everything the round has credited plus this
contribution. A client that lied about a settlement would first have to put
the money in the vault, at which point it is not a lie.

### I3 and I4 — enforced by the program

`disburse` checks and sets the disbursed flag in the same instruction that
moves the money. Two concurrent calls both write the round account, so the
runtime serializes them and the second observes the flag already set. There is
no check-then-act window because the check and the act are one instruction.

I3 is checked twice, in `close_round` and again in `disburse`, because it is
one of the two invariants that must never fail and a single check is a single
place to get it wrong.

## 3. What a malicious wallet can do

This is the attacker with the most leverage, because MWA 2.0 makes the wallet
both the signer and the broadcaster.

| Attack | Outcome |
|---|---|
| Refuse to broadcast, report success | The nonce never advances. The verdict is `NOT_SENT`. Nobody is charged. |
| Broadcast, report failure | The nonce advances and the transaction is found by hash. The verdict is `SETTLED`. The lie does not survive. |
| Broadcast and never return | The normal case this product exists for. Resolved from the nonce account. |
| **Rewrite the message before broadcasting** | **The nonce value is replaced, the recorded hash no longer matches, and the slot escalates as `FOREIGN_CONSUMER`.** The member's funds may have moved somewhere the app did not intend. |
| Broadcast a different transfer entirely | Same as above: hash mismatch, honest escalation, no silent credit. |

The fourth row is the real exposure and it is **not** fully mitigated. A wallet
that rewrites the transaction can move the member's funds, because the member
signed through that wallet. What Quittance guarantees is narrower and still
worth having: **it will never report that as paid**. The mismatch is detected,
the slot escalates with the evidence attached, and a human decides.

Experiment E8 exists to find out whether real wallets do this. It is the first
thing that runs, before anything else is built on top, and a wallet that fails
it is refused rather than worked around — `unusableWalletMessage` in
`packages/engine/src/capabilities.ts`.

## 4. What a malicious client can do

The program takes the slot's state as an argument, because a Solana program
cannot read arbitrary transaction history and therefore cannot re-derive a
verdict for itself. This is a real seam and it is worth being precise about.

| Attack | Outcome |
|---|---|
| Claim `SETTLED` without paying | Refused. The vault check means the money must already be there. |
| Claim `NOT_SENT` after paying | Accepted on chain, and it credits nothing — the attacker has donated to the vault. Detected by the verifier, which recomputes from chain state and reports a `VERDICT_DIVERGENCE`. |
| Claim `REJECTED` after paying | Same as above. |
| Record another member's contribution | Refused. A machine verdict must be signed by the member it belongs to. |
| Forge an organizer override | Refused. An override must be signed by the circle's organizer. |
| Edit the local intent log before export | Detected. The verifier recomputes the canonical digest and reports `INTENT_HASH_FAILURE`, separately from a verdict divergence, so a reader knows whether the data or the logic was wrong. |

The pattern: a malicious client can harm **itself** — donate funds, under-claim
its own payments — and cannot harm anyone else, and cannot make the ledger
show a credit that the vault does not back.

## 5. What a malicious organizer can do

The organizer is the most privileged party in a circle, so this matters.

| Attack | Outcome |
|---|---|
| Take the pot | Refused. The vault's authority is a PDA; `disburse` pays `round.recipient` and nothing else. |
| Redirect a payout | Refused. The recipient is frozen when the round opens, and `disburse` checks the passed account against it. |
| Reorder the rotation to collect twice | Refused at creation. `is_permutation` rejects a rotation order that repeats or omits a member. |
| Pay out early, before everyone has paid | Refused. I3, checked twice. |
| Pay out twice | Refused. I4. |
| Accept an unpaid contribution as paid | Possible, **and recorded**. Subject to the vault check, so they cannot credit money that is not there — but they can absorb a shortfall. The decision is attributed to them by pubkey and timestamp, kept on chain with the original escalation reason intact, and reported by the verifier on its own line. It is never presented as a chain fact. |
| Mark a paid contribution unpaid | Possible, and the same applies. The old nonce must be provably advanced first, which is itself an on-chain record. |

A circle is a group of people who already know each other. The design does not
try to make the organizer trustless; it makes every discretionary act leave a
signed, attributed, public trace.

## 6. What a network attacker can do

| Attack | Outcome |
|---|---|
| Drop or delay RPC responses | No verdict is produced. The slot keeps its state and the screen says the network could not be reached. Bounded retry; a read failure is never a verdict. |
| Return a stale slot | The nonce read is `finalized`, so a stale `confirmed` view cannot authorize a rebroadcast. This is fault F6. |
| Return a forged transaction | The message hash is recomputed from the bytes the node returned and compared to the recorded intent. A forged transaction does not match, and the slot escalates. |
| Censor one member's transaction | The nonce never advances, the verdict is `NOT_SENT`, and the member can resend. Censorship delays a payment; it cannot fabricate one. |
| MITM the RPC endpoint | TLS. The endpoint is https and `scripts/check-env.mjs` refuses a non-https URL, since an RPC URL carries an API key in its query string. |

A node that lies can cause an **escalation**, which is a refusal to decide. It
cannot cause a silent wrong answer, because every claim the node makes about a
transaction is checked against a hash computed before the wallet was opened.

## 7. The MWA session boundary

The protocol has no session resumption, no delivery receipt, and no
idempotency key. An MWA request hands off via an Android intent, which
backgrounds the dApp, and Android may kill a backgrounded process at any time.

Quittance treats a lost session as **the expected case**, not an error. The
promise rejecting, or the process simply ceasing to exist, tells us nothing
about whether money moved, and nothing in the codebase interprets it as though
it did. The answer comes from the nonce account.

## 8. Seed Vault

The key never leaves the TEE, so the app cannot re-sign on its own. This is
usually described as a constraint; here it is the premise. Because the app
cannot reconstruct a signature locally, the recovery oracle **must** live on
chain. A design that could re-sign would be tempted to re-sign, and re-signing
without knowing whether the first attempt landed is precisely how a double
charge happens.

## 9. Key handling in this repository

- Devnet keypairs live in `.keys/`, which is gitignored, and the ignore rule
  was verified with `git check-ignore` before any key was written.
- The program keypair is in `program/keys/`, also gitignored.
- `.env` is gitignored; `.env.example` is committed and contains no key.
- No script prints an API key. `scripts/check-env.mjs` and the verifier both
  print the RPC **host** only.
- No key material is in any committed file. These are devnet keys holding no
  real value, and they are still treated as keys.

## 10. Known gaps

Stated plainly, because a threat model that lists only what it defends against
is marketing.

1. **A wallet that rewrites transactions can move funds.** Detected, never
   silently credited, not prevented. E8 measures whether this is real.
2. **The program cannot re-derive `REJECTED` versus `NOT_SENT`.** Neither
   credits anything, and the verifier distinguishes them from chain state, but
   the on-chain record reflects what the client asserted.
3. **An organizer can absorb a shortfall** by accepting an unpaid contribution.
   Bounded by the vault check, attributed, and visible.
4. **`BEYOND_RETENTION` is unrecoverable by design.** If the nonce advanced and
   no node retains the signature, the answer is genuinely unavailable, and
   Quittance escalates rather than guessing. No amount of engineering recovers
   data the network no longer holds.
5. **Nothing here has been audited.** Two security researchers judge this
   hackathon; this document is written for them to attack, not to reassure.

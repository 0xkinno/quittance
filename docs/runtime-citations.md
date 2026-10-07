# Runtime source citations

Every claim Quittance makes about durable nonce behaviour is confirmed by
reading the validator source, not by reading documentation. This file records
the exact file, line range, and the reasoning each citation supports.

**Source:** `anza-xyz/agave`
**Commit:** `e818d643945cd82c7144013af58ccf82d31df2dd`
**Dated:** 2026-10-05

The repository was cloned for local study only. No code from it is vendored,
copied, or linked into this build.

---

## C1 — Age validation falls through to the durable nonce check

`runtime/src/bank/check_transactions.rs:35-49`

```rust
let next_durable_nonce = hash_queue.next_durable_nonce();

if self.check_blockhash_age(tx, max_age, &hash_queue) {
    return Ok(None);
}

if let Some(nonce_address) = self.check_nonce_semantics(tx, &next_durable_nonce)
    && self.check_nonce_account(tx, nonce_address, true).is_some()
{
    return Ok(Some(nonce_address));
}

error_counters.blockhash_not_found += 1;
Err(TransactionError::BlockhashNotFound)
```

**Supports:** a durable nonce transaction is not subject to blockhash
expiry. `check_blockhash_age` is attempted first; when it fails the function
does not reject, it falls through to the nonce path. A transaction whose
`recent_blockhash` field holds a stored nonce value is therefore valid for as
long as that nonce remains unadvanced — across process death, reboot, and
arbitrary offline time.

`check_nonce_semantics` at lines 205-216 shows the gate: a nonce is only
advanceable while `tx.recent_blockhash() != next_durable_nonce.as_hash()`.

## C2 — The nonce is advanced before execution, and reuse is rejected

`svm/src/transaction_processor.rs:929-958`

```rust
// This function verifies:
// * Nonce account owner is SystemProgram
// * Nonce account parses as State::Initialized
// * Stored durable nonce matches the message blockhash
let Some(nonce_data) = verify_nonce_account(&nonce_account, message.recent_blockhash())
else {
    error_counters.blockhash_not_found += 1;
    return Err(TransactionError::BlockhashNotFound);
};

let nonce_can_be_advanced = &nonce_data.durable_nonce != next_durable_nonce;
let nonce_authority_is_valid = message
    .get_ix_signers(NONCED_TX_MARKER_IX_INDEX as usize)
    .any(|signer| signer == &nonce_data.authority);

if nonce_can_be_advanced && nonce_authority_is_valid {
    // ... set_state to next_durable_nonce ...
    Ok(NonceInfo::new(*nonce_address, nonce_account))
} else {
    error_counters.blockhash_not_found += 1;
    Err(TransactionError::BlockhashNotFound)
}
```

**Supports invariant I1, exactly-once debit.** The stored nonce must equal the
message's blockhash field for the transaction to validate at all. Once the
account has advanced, an identical rebroadcast fails `verify_nonce_account`
and is rejected with `BlockhashNotFound` before execution. The replay
guarantee is enforced here, in the validator, not in Quittance. A retry loop
in the app cannot double-charge because the runtime drops the duplicate.

`NONCED_TX_MARKER_IX_INDEX` is also the confirmation that the nonce authority
must sign the **first** instruction — which is why the advance instruction is
required to be first, and which is what makes the nonce account a complete
index of the transactions that touched it.

## C3 — Rollback then advance: the nonce advances even when the transfer fails

`svm/src/rollback_accounts.rs:64-87`

```rust
if let Some(nonce) = nonce {
    if &fee_payer_address == nonce.address() {
        // `nonce` contains an AccountSharedData which has already been
        // advanced to the current DurableNonce
        // ...
```

**Supports the three-state model.** `RollbackAccounts` is the state the
runtime persists after a transaction that executed and failed. The nonce
account captured there is the **already-advanced** account, not the
pre-execution one. So a failed transfer still leaves the nonce advanced.

This is the nuance the entire verdict machine is built around:

> **"Nonce advanced" means processed, not paid.**

A design that reads the nonce as a boolean paid/not-paid flag credits failed
transfers. Quittance therefore has three terminal on-chain outcomes —
`SETTLED`, `REJECTED`, `NOT_SENT` — and never two.

## C4 — The runtime states the reason in its own words

`svm/src/nonce_info.rs:35-37`

```rust
// Advance the stored blockhash to prevent fee theft by someone
// replaying nonce transactions that have failed with an
// `InstructionError`.
```

**Supports C3 directly.** The advance-on-failure is deliberate and its stated
purpose is anti-replay. This is not an implementation quirk that might be
fixed; it is the mechanism working as designed.

## C5 — A nonce account can advance at most once per slot

`programs/system/src/system_instruction.rs:50-57`

```rust
let next_durable_nonce =
    DurableNonce::from_blockhash(&invoke_context.environment_config.blockhash);
if data.durable_nonce == next_durable_nonce {
    ic_msg!(
        invoke_context,
        "Advance nonce account: nonce can only advance once per slot"
    );
    return Err(SystemError::NonceBlockhashNotExpired.into());
}
```

**Supports two engine design decisions.**

1. The **reissue** path. The `AMBIGUOUS` resolution action *Mark unpaid and
   reissue* must advance the nonce before a replacement transaction is built,
   so the old transaction can never land. That advance can fail with
   `NonceBlockhashNotExpired` if the account already advanced in the current
   slot. The engine treats this as retryable-after-a-slot, never as a failure
   of the reissue, and never proceeds to build the replacement until the
   advance has confirmed.
2. The **lease recycling** path. Nonce accounts are recycled between rounds by
   advancing them. The lease must not attempt to recycle an account that
   advanced in the current slot, so recycling is slot-aware and serialized per
   account.

## C6 — `AdvanceNonceAccount` requires the recent blockhash list to be non-empty

`programs/system/src/system_processor.rs:410-427`

The instruction returns `SystemError::NonceNoRecentBlockhashes` when the
sysvar list is empty. Recorded for completeness: it is not reachable on a
live cluster, and Quittance does not special-case it beyond surfacing it as a
`REJECTED` instruction error with its program log attached.

---

## What is not confirmed by source

These remain `UNKNOWN` until an experiment on real hardware settles them, and
they are tracked in `LIMITATIONS.md`.

| Question | Status | Settled by |
|---|---|---|
| Does a compliant wallet preserve the nonce value in the message rather than substituting a recent blockhash? | `UNKNOWN` | Experiment E8 |
| Which signing methods does each wallet actually implement? | `UNKNOWN` | Experiment E7 |
| Does Android kill the dApp process during the wallet handoff often enough to matter in practice? | `UNKNOWN` | Experiments E1–E5 |

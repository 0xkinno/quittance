/**
 * Canonical encoding and hashing.
 *
 * Two hashes matter in this system and they answer different questions.
 *
 *   `hashCompiledMessage`  — "is the transaction that consumed my nonce the
 *                            transaction I built?"  Hashed over the compiled
 *                            message bytes, because those bytes are what the
 *                            chain stores and returns.
 *
 *   `hashIntentRecord`     — "has the stored intent been edited since it was
 *                            written?"  Hashed over a canonical serialization
 *                            of the record, so the verifier can report an
 *                            edited intent separately from a diverged verdict.
 *
 * Conflating the two is how a verifier ends up unable to say which of the two
 * things went wrong, so they are deliberately separate functions over
 * deliberately separate inputs.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { IntentRecord, Sha256Hex } from './types.ts';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Decode base64 to bytes without depending on a Node-only or RN-only global. */
export function base64ToBytes(base64: string): Uint8Array {
  if (base64.length === 0) return new Uint8Array(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new Error('base64ToBytes: input is not canonical base64');
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;

  const out = new Uint8Array((base64.length / 4) * 3 - padding);
  let outIndex = 0;
  for (let i = 0; i < base64.length; i += 4) {
    let chunk = 0;
    for (let j = 0; j < 4; j += 1) {
      const char = base64[i + j] as string;
      const value = char === '=' ? 0 : alphabet.indexOf(char);
      if (value < 0) throw new Error('base64ToBytes: input is not canonical base64');
      chunk = (chunk << 6) | value;
    }
    const bytes = [(chunk >> 16) & 0xff, (chunk >> 8) & 0xff, chunk & 0xff];
    for (const byte of bytes) {
      if (outIndex < out.length) out[outIndex++] = byte;
    }
  }
  return out;
}

/** Encode bytes to base64 without depending on a Node-only or RN-only global. */
export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    const chunk = (b0 << 16) | (b1 << 8) | b2;
    out += alphabet[(chunk >> 18) & 0x3f];
    out += alphabet[(chunk >> 12) & 0x3f];
    out += i + 1 < bytes.length ? alphabet[(chunk >> 6) & 0x3f] : '=';
    out += i + 2 < bytes.length ? alphabet[chunk & 0x3f] : '=';
  }
  return out;
}

/** sha256 over raw bytes, lowercase hex. */
export function sha256Hex(bytes: Uint8Array): Sha256Hex {
  return bytesToHex(sha256(bytes));
}

/** sha256 over a UTF-8 string, lowercase hex. */
export function sha256HexOfString(value: string): Sha256Hex {
  return sha256Hex(new TextEncoder().encode(value));
}

// ---------------------------------------------------------------------------
// The message hash — the identity test for "is this my transaction?"
// ---------------------------------------------------------------------------

/**
 * Hash the compiled transaction message.
 *
 * The input is the *message*, not the transaction: signatures are excluded
 * deliberately. A wallet may produce a transaction whose signature differs
 * from anything the app could predict, and the app never holds the signature
 * in the mandatory signing path at all. The message is the part that encodes
 * the intent — the accounts, the amounts, the nonce — and it is the part the
 * chain returns on `getTransaction`.
 *
 * So this hash answers exactly the question the verdict machine asks: did the
 * transaction that consumed my nonce carry the instructions I built?
 */
export function hashCompiledMessage(messageBytes: Uint8Array): Sha256Hex {
  if (messageBytes.length === 0) {
    throw new Error('hashCompiledMessage: refusing to hash an empty message');
  }
  return sha256Hex(messageBytes);
}

/** Convenience wrapper for the base64 form that is stored and returned by RPC. */
export function hashCompiledMessageBase64(messageBase64: string): Sha256Hex {
  return hashCompiledMessage(base64ToBytes(messageBase64));
}

// ---------------------------------------------------------------------------
// The intent hash — the tamper test for "has the stored record been edited?"
// ---------------------------------------------------------------------------

/**
 * Serialize an intent record canonically.
 *
 * Canonical means: fixed field order, no whitespace, `bigint` rendered as a
 * decimal string, and no dependence on `JSON.stringify` key ordering. The
 * same record must produce byte-identical output on the device and in the
 * verifier, on any engine, forever, or the tamper test is worthless.
 *
 * Fields deliberately excluded:
 *
 *   `signedTransactionBase64`  an optional optimization that is present or
 *                              absent depending on the wallet, and must not
 *                              change the identity of the intent.
 *   `walletCapabilities`       evidence about the environment, not about the
 *                              intent; recorded alongside it, not inside it.
 *
 * Including either would make a record's hash depend on which wallet happened
 * to be installed, which would produce tamper alarms that are not tampering.
 */
export function canonicalizeIntent(intent: IntentRecord): string {
  const fields: ReadonlyArray<readonly [string, string | number]> = [
    ['schemaVersion', intent.schemaVersion],
    ['slotId', intent.slotId],
    ['circleId', intent.circleId],
    ['roundIndex', intent.roundIndex],
    ['memberPubkey', intent.memberPubkey],
    ['noncePubkey', intent.noncePubkey],
    ['nonceValueAtBuild', intent.nonceValueAtBuild],
    ['nonceAuthority', intent.nonceAuthority],
    ['messageHash', intent.messageHash],
    ['messageBase64', intent.messageBase64],
    ['expectedFrom', intent.transfer.expectedFrom],
    ['expectedTo', intent.transfer.expectedTo],
    ['expectedMint', intent.transfer.expectedMint],
    ['expectedAmount', intent.transfer.expectedAmount.toString(10)],
    ['mintDecimals', intent.transfer.mintDecimals],
    ['createdAtMs', intent.createdAtMs],
    ['builtAtChainSlot', intent.builtAtChainSlot],
  ];

  return fields
    .map(([key, value]) => `${key}=${typeof value === 'number' ? value.toString(10) : value}`)
    .join('\n');
}

/**
 * The tamper digest for a stored intent.
 *
 * The verifier recomputes this from the stored record and compares it to the
 * digest recorded in the evidence log. A mismatch means the stored intent was
 * edited after it was written, which is reported as `INTENT_HASH_FAILURE` and
 * never as a verdict divergence.
 */
export function hashIntentRecord(intent: IntentRecord): Sha256Hex {
  return sha256HexOfString(canonicalizeIntent(intent));
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/**
 * Constant-time-ish comparison of two hex digests.
 *
 * Nothing in Quittance's threat model turns on digest-comparison timing — the
 * comparison runs on the device against values the device itself recorded. It
 * is written this way so that no reviewer has to pause and work out whether
 * it matters.
 */
export function digestsEqual(left: Sha256Hex, right: Sha256Hex): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}

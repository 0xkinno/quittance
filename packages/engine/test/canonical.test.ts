/**
 * Canonical encoding and the two hashes.
 *
 * The tamper test and the identity test must stay separate, and each must
 * respond only to the thing it is supposed to detect. These tests pin that
 * down, because if the two hashes ever start reacting to the same inputs the
 * verifier loses the ability to say whether the data or the logic was wrong.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  base64ToBytes,
  bytesToBase64,
  canonicalizeIntent,
  digestsEqual,
  hashCompiledMessage,
  hashCompiledMessageBase64,
  hashIntentRecord,
  sha256Hex,
} from '../src/canonical.ts';
import { makeScenario } from './fixtures.ts';

describe('base64', () => {
  it('round-trips every byte value', () => {
    for (let length = 0; length <= 64; length += 1) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 7 + length) % 256;
      assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
    }
  });

  it('round-trips an all-bytes buffer', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) bytes[i] = i;
    assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  });

  it('refuses non-canonical input rather than decoding it loosely', () => {
    // A lenient decoder would let a corrupted stored message hash to
    // something plausible. Refusing is the only safe behaviour here.
    assert.throws(() => base64ToBytes('AAA'), /canonical base64/);
    assert.throws(() => base64ToBytes('A!=='), /canonical base64/);
    assert.throws(() => base64ToBytes('====' ), /canonical base64/);
  });

  it('agrees with a known sha256 vector', () => {
    // sha256 of the empty string, so the digest function itself is pinned.
    assert.equal(
      sha256Hex(new Uint8Array(0)),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('the message hash — the identity test', () => {
  it('matches when the chain returns the message that was built', () => {
    const scenario = makeScenario();
    assert.ok(
      digestsEqual(
        hashCompiledMessageBase64(scenario.ourMessageBase64),
        scenario.intent.messageHash,
      ),
    );
  });

  it('differs for a different transaction against the same nonce account', () => {
    const scenario = makeScenario();
    assert.ok(
      !digestsEqual(
        hashCompiledMessageBase64(scenario.foreignMessageBase64),
        scenario.intent.messageHash,
      ),
    );
  });

  it('refuses to hash an empty message', () => {
    assert.throws(() => hashCompiledMessage(new Uint8Array(0)), /empty message/);
  });
});

describe('the intent hash — the tamper test', () => {
  it('is stable across repeated calls', () => {
    const scenario = makeScenario();
    assert.equal(hashIntentRecord(scenario.intent), hashIntentRecord(scenario.intent));
  });

  it('changes when the amount is edited', () => {
    const scenario = makeScenario();
    const tampered = {
      ...scenario.intent,
      transfer: { ...scenario.intent.transfer, expectedAmount: 1n },
    };
    assert.notEqual(hashIntentRecord(tampered), hashIntentRecord(scenario.intent));
  });

  it('changes when the destination is edited', () => {
    const scenario = makeScenario();
    const tampered = {
      ...scenario.intent,
      transfer: { ...scenario.intent.transfer, expectedTo: scenario.intent.memberPubkey },
    };
    assert.notEqual(hashIntentRecord(tampered), hashIntentRecord(scenario.intent));
  });

  it('changes when the recorded nonce value is edited', () => {
    const scenario = makeScenario();
    const tampered = { ...scenario.intent, nonceValueAtBuild: 'something-else' };
    assert.notEqual(hashIntentRecord(tampered), hashIntentRecord(scenario.intent));
  });

  it('does not change when optional signed bytes are attached', () => {
    const scenario = makeScenario();
    const withBytes = { ...scenario.intent, signedTransactionBase64: 'AAAA' };
    // The signed-bytes optimization is present or absent depending on which
    // wallet happens to be installed. If it fed the tamper hash, swapping
    // wallets would raise a tamper alarm that is not tampering.
    assert.equal(hashIntentRecord(withBytes), hashIntentRecord(scenario.intent));
  });

  it('does not change when the wallet capability record changes', () => {
    const scenario = makeScenario();
    const otherWallet = {
      ...scenario.intent,
      walletCapabilities: {
        ...scenario.intent.walletCapabilities,
        walletLabel: 'a-different-wallet',
      },
    };
    assert.equal(hashIntentRecord(otherWallet), hashIntentRecord(scenario.intent));
  });

  it('serializes bigint amounts as decimal, never via JSON', () => {
    const scenario = makeScenario(undefined, 20_000_000n);
    const canonical = canonicalizeIntent(scenario.intent);
    assert.ok(canonical.includes('expectedAmount=20000000'));
    // One field per line, so the encoding cannot be ambiguous about where a
    // value ends — a separator that could appear inside a value would make
    // two different records canonicalize identically.
    assert.ok(canonical.split('\n').every((line) => line.includes('=')));
  });
});

describe('digest comparison', () => {
  it('is true only for identical digests', () => {
    assert.ok(digestsEqual('abc', 'abc'));
    assert.ok(!digestsEqual('abc', 'abd'));
    assert.ok(!digestsEqual('abc', 'ab'));
  });
});

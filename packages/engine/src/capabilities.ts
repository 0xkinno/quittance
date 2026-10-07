/**
 * Wallet capability probing.
 *
 * MWA 2.0 made `signAndSendTransactions` mandatory for wallets and deprecated
 * `signTransactions` and `reauthorize`. The Solana Mobile documentation states
 * that `signTransactions` is deprecated per the MWA 2.0 spec, that wallets may
 * retain it only for backwards compatibility, and that dApps are recommended
 * to use `signAndSendTransactions`, under which the wallet handles both
 * signing and submitting to the network.
 *
 * That single spec change is where the whole product comes from. Under the
 * only guaranteed signing path:
 *
 *   - the wallet broadcasts, not the app;
 *   - the app never holds the signed transaction bytes;
 *   - the app learns the signature only when the MWA session returns.
 *
 * And an MWA request hands off to the wallet via an Android intent, which
 * backgrounds the app, and Android may kill a backgrounded process at any
 * time. There is no session resumption in the protocol, no delivery receipt,
 * and no idempotency key.
 *
 * So this module does two things and refuses to do a third. It records what a
 * wallet says it supports, and it uses `signTransactions` as an optimization
 * when present. It never makes the guarantee depend on an optional method.
 */

import type { WalletCapabilityRecord } from './types.ts';

/**
 * The shape an MWA `getCapabilities` response is read through.
 *
 * Fields are optional because this is parsing another program's output: a
 * wallet may omit anything, and a missing field is read as "not supported"
 * rather than as a reason to throw. Unknown extra fields are preserved
 * verbatim in `rawCapabilities` for the evidence log.
 */
export interface RawCapabilitiesResponse {
  readonly features?: readonly string[];
  readonly supported_transaction_versions?: readonly (number | string)[];
  readonly max_transactions_per_request?: number;
  readonly max_messages_per_request?: number;
  readonly [key: string]: unknown;
}

/** Feature identifiers as they appear in an MWA capabilities response. */
export const FEATURE_SIGN_AND_SEND_TRANSACTIONS = 'solana:signAndSendTransaction';
export const FEATURE_SIGN_TRANSACTIONS = 'solana:signTransactions';
export const FEATURE_SIGN_MESSAGES = 'solana:signMessages';

/**
 * Read a capability record out of a wallet's `getCapabilities` response.
 *
 * `preservesDurableNonce` is set to `null` and left there. No response field
 * reports it, and there is no way to infer it: a wallet could advertise
 * every method and still rewrite the message it broadcasts. Only experiment
 * E8 settles it, and until E8 has run against a given wallet this stays
 * `null` rather than optimistic.
 */
export function readCapabilities(
  raw: RawCapabilitiesResponse,
  walletLabel: string,
  probedAtMs: number,
): WalletCapabilityRecord {
  const features = new Set(raw.features ?? []);

  return {
    supportsSignAndSendTransactions: features.has(FEATURE_SIGN_AND_SEND_TRANSACTIONS),
    supportsSignTransactions: features.has(FEATURE_SIGN_TRANSACTIONS),
    supportsSignMessages: features.has(FEATURE_SIGN_MESSAGES),
    preservesDurableNonce: null,
    walletLabel,
    rawCapabilities: { ...raw },
    probedAtMs,
  };
}

/**
 * Record the outcome of the E8 probe against a wallet.
 *
 * E8 builds a durable nonce transaction, sends it through
 * `signAndSendTransactions`, and reads back the transaction the chain
 * actually received to confirm the wallet did not substitute a recent
 * blockhash for the nonce value. This is the gate: a wallet that rewrites the
 * message cannot carry the guarantee, and the app must say so rather than
 * silently producing verdicts that cannot be trusted.
 */
export function withNoncePreservationResult(
  record: WalletCapabilityRecord,
  preservesDurableNonce: boolean,
): WalletCapabilityRecord {
  return { ...record, preservesDurableNonce };
}

/** Whether this wallet can be used to make a contribution at all. */
export function isUsableForContributions(record: WalletCapabilityRecord): boolean {
  return record.supportsSignAndSendTransactions;
}

/**
 * Whether the exact-byte rebroadcast optimization is available.
 *
 * When this is false, recovery rebroadcasts by asking the wallet to sign and
 * send the recorded message again. The nonce makes that safe: if the original
 * already landed, the nonce has advanced and the second attempt is dropped by
 * the runtime before execution. The optimization saves a wallet round trip.
 * It does not create the safety.
 */
export function canRebroadcastExactBytes(record: WalletCapabilityRecord): boolean {
  return record.supportsSignTransactions;
}

/**
 * The human-facing sentence for a wallet that cannot carry the guarantee.
 *
 * Errors in this product do not apologize and are not vague. They say what
 * is wrong, and what the person can do about it.
 */
export function unusableWalletMessage(record: WalletCapabilityRecord): string | null {
  if (!record.supportsSignAndSendTransactions) {
    return (
      `${record.walletLabel} does not offer the signing method Quittance needs. ` +
      'Install a wallet that supports Mobile Wallet Adapter 2.0 and open Quittance again.'
    );
  }
  if (record.preservesDurableNonce === false) {
    return (
      `${record.walletLabel} rewrites the part of a payment that Quittance uses to prove ` +
      'the payment happened. Contributions through this wallet cannot be guaranteed, so ' +
      'Quittance will not collect through it. Use a different wallet for this circle.'
    );
  }
  return null;
}

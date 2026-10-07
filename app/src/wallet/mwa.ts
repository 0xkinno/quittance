/**
 * Mobile Wallet Adapter.
 *
 * This file is the boundary the entire product is built around, so it is
 * worth being precise about what happens here.
 *
 * MWA 2.0 made `signAndSendTransactions` mandatory and deprecated
 * `signTransactions`. Under the mandatory path the wallet signs **and**
 * broadcasts, which means:
 *
 *   - the app never holds the signed transaction bytes;
 *   - the app learns the signature only when the session returns;
 *   - and the session runs across an Android intent that backgrounds this
 *     process, which Android may then kill at any moment.
 *
 * There is no session resumption in the protocol, no delivery receipt, and no
 * idempotency key. So `signAndSend` below has a failure mode that is not an
 * error: the promise can reject, or the process can simply cease to exist,
 * while the transaction is already on its way to being final.
 *
 * Every function here treats that as the expected case rather than an
 * exception. The answer is never recovered from this file — it is recovered
 * from the nonce account, by the resolver.
 */

import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import type { Web3MobileWallet } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { PublicKey, Transaction } from '@solana/web3.js';
import { toByteArray } from 'react-native-quick-base64';

import {
  readCapabilities,
  withNoncePreservationResult,
  type Base58Signature,
  type IntentRecord,
  type WalletCapabilityRecord,
  type WalletBroadcaster,
} from '@quittance/engine';

/** Shown to the wallet so the member knows what is asking. */
export const APP_IDENTITY = {
  name: 'Quittance',
  uri: 'https://quittance.app',
  icon: 'favicon.ico',
} as const;

/** Devnet for this build. See `.env` and `LIMITATIONS.md`. */
export const CHAIN = 'solana:devnet' as const;

export interface WalletSession {
  readonly address: PublicKey;
  readonly authToken: string;
  readonly capabilities: WalletCapabilityRecord;
  readonly label: string;
}

/**
 * Connect and probe in one session.
 *
 * The capability probe is recorded with every intent, so a campaign row can
 * always be attributed to the wallet behaviour that produced it, and so no
 * verdict can later be explained away with "it probably supported a different
 * method".
 */
export async function connectAndProbe(): Promise<WalletSession> {
  return transact(async (wallet: Web3MobileWallet) => {
    const authorization = await wallet.authorize({
      chain: CHAIN,
      identity: APP_IDENTITY,
    });

    const account = authorization.accounts[0];
    if (account === undefined) {
      throw new WalletError(
        'The wallet returned no account. Open your wallet, make sure it has at least one ' +
          'account on devnet, and try again.',
      );
    }

    const label = authorization.wallet_uri_base ?? account.label ?? 'this wallet';

    // `getCapabilities` is read through a tolerant parser: a wallet may omit
    // any field, and a missing field is read as "not supported" rather than
    // as a reason to fail. Unknown fields are kept verbatim for the record.
    let capabilities: WalletCapabilityRecord;
    try {
      const raw = await wallet.getCapabilities();
      capabilities = readCapabilities(
        raw as Record<string, unknown>,
        label,
        Date.now(),
      );
    } catch {
      // A wallet that will not answer `getCapabilities` is recorded as
      // offering only what MWA 2.0 makes mandatory. That is the conservative
      // reading, and it is the one under which the guarantee must hold
      // anyway, so nothing downstream changes.
      capabilities = readCapabilities({ features: [] }, label, Date.now());
    }

    return {
      address: new PublicKey(toByteArray(account.address)),
      authToken: authorization.auth_token,
      capabilities,
      label,
    };
  });
}

/**
 * The mandatory signing path, wrapped as the engine's `WalletBroadcaster`.
 *
 * Note what this does **not** do. It does not retry, it does not confirm, and
 * it does not interpret a missing result. A failed first broadcast is
 * indistinguishable from a successful one whose session died, so retrying
 * here would be guessing — and guessing is the thing this product exists to
 * stop doing.
 */
export class MwaBroadcaster implements WalletBroadcaster {
  private readonly authToken: string;
  private readonly rebuild: (intent: IntentRecord) => Transaction;

  constructor(authToken: string, rebuild: (intent: IntentRecord) => Transaction) {
    this.authToken = authToken;
    this.rebuild = rebuild;
  }

  async signAndSend(intent: IntentRecord): Promise<Base58Signature> {
    const transaction = this.rebuild(intent);

    return transact(async (wallet: Web3MobileWallet) => {
      await wallet.reauthorize({
        auth_token: this.authToken,
        identity: APP_IDENTITY,
      });

      const signatures = await wallet.signAndSendTransactions({
        transactions: [transaction],
      });

      const signature = signatures[0];
      if (signature === undefined) {
        // The session returned without a signature. Not treated as proof of
        // anything: the resolver reads the nonce account and finds out.
        throw new SessionLostError(
          'The wallet session ended without returning a result.',
        );
      }
      return signature;
    });
  }
}

/**
 * The E8 probe.
 *
 * E8 is the thesis gate. It builds a durable nonce transaction, sends it
 * through the mandatory path, and then reads back what the chain actually
 * received, to confirm the wallet did not substitute a recent blockhash for
 * the nonce value.
 *
 * If a wallet rewrites the message, that wallet cannot carry the guarantee,
 * and the app says so rather than producing verdicts that cannot be trusted.
 * The result is recorded on the capability record, never assumed.
 */
export async function recordNoncePreservation(
  capabilities: WalletCapabilityRecord,
  observedMessageMatchesBuilt: boolean,
): Promise<WalletCapabilityRecord> {
  return withNoncePreservationResult(capabilities, observedMessageMatchesBuilt);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A wallet problem the member can act on.
 *
 * Errors in this product do not apologize and are not vague. They say what is
 * wrong and what would fix it.
 */
export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

/**
 * The session ended without a result.
 *
 * Deliberately a distinct type, because it is **not** a failure. It is the
 * condition the entire product is built around, and the only correct response
 * to it is to leave the slot in flight and let the resolver read the chain.
 */
export class SessionLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLostError';
  }
}

/** Turn any wallet-layer throw into a sentence a member can act on. */
export function describeWalletFailure(error: unknown): string {
  if (error instanceof SessionLostError) {
    return 'The wallet closed before telling us what happened. Quittance will find out from the chain.';
  }
  if (error instanceof WalletError) return error.message;

  const text = error instanceof Error ? error.message : String(error);

  if (/no wallet|not found|ERR_WALLET_NOT_FOUND|ActivityNotFound/i.test(text)) {
    return 'No Solana wallet is installed. Install one that supports Mobile Wallet Adapter, then open Quittance again.';
  }
  if (/declin|reject|cancel/i.test(text)) {
    return 'You declined the request in your wallet. Nothing was sent.';
  }
  if (/timeout|timed out/i.test(text)) {
    return 'The wallet did not respond. Quittance will check the chain and tell you where this payment stands.';
  }
  return 'The wallet could not complete the request. Quittance will check the chain before anything is recorded.';
}

'use client';

/**
 * The wallet connection boundary.
 *
 * Wraps the app in Solana's `ConnectionProvider` and `WalletProvider`, pointed
 * at devnet — the same cluster the program is deployed to and the same one
 * every other number on this site is measured against.
 *
 * `wallets={[]}` is deliberate, not an oversight. Wallet Adapter resolves
 * installed wallets through the Wallet Standard registry automatically —
 * Phantom, Solflare, Backpack and anything else that registers itself on
 * `window` — so no wallet-specific package has to be installed or kept in
 * sync. A wallet this list does not know about still shows up.
 */

import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from '@solana/wallet-adapter-react';
import { useMemo, type ReactNode } from 'react';

import { DEVNET_RPC_URL } from '@/lib/config';

export function WalletProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  // A dedicated devnet RPC is deliberately not swapped in here. The public
  // endpoint is slower, and that is the correct trade for a page a stranger's
  // browser talks to directly: nothing in this file carries an API key that a
  // page source view could expose.
  const endpoint = useMemo(() => DEVNET_RPC_URL, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={[]} autoConnect>
        {children}
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}

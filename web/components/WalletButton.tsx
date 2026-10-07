'use client';

/**
 * The wallet button.
 *
 * Not `@solana/wallet-adapter-react-ui`'s default button: that component ships
 * its own dark, rounded, drop-shadowed styling that would be the one thing on
 * this page fighting the ledger-on-paper design rather than belonging to it.
 * This is built on the same `useWallet` hook with the product's own tokens.
 *
 * Three states, and the copy for each is written the way every other screen
 * in this product writes its states — plainly, never "maybe":
 *
 *   not connected   "Connect wallet"
 *   connecting      a disabled button saying so
 *   connected       the address, shortened, with a disconnect affordance
 */

import { useWallet } from '@solana/wallet-adapter-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import styles from './wallet-button.module.css';

function shorten(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function WalletButton(): React.JSX.Element {
  const { wallets, wallet, select, connect, disconnect, connecting, connected, publicKey } =
    useWallet();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (event: MouseEvent): void => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const installed = wallets.filter(
    (entry) => entry.readyState === 'Installed' || entry.readyState === 'Loadable',
  );

  const pick = useCallback(
    async (name: (typeof wallets)[number]['adapter']['name']) => {
      select(name);
      setOpen(false);
    },
    [select],
  );

  // Wallet Adapter connects automatically once a wallet is selected and
  // autoConnect is on, but the very first pick in a session needs an explicit
  // connect() — select() alone only arms it.
  useEffect(() => {
    if (wallet !== null && !connected && !connecting) {
      connect().catch(() => {
        // A declined connection is not an error state worth surfacing here;
        // the button simply stays in its "connect" state.
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet]);

  if (connected && publicKey !== null) {
    return (
      <div className={styles.wrap} ref={menuRef}>
        <button
          type="button"
          className={styles.connected}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className={styles.dot} aria-hidden />
          <span className="mono">{shorten(publicKey.toBase58())}</span>
        </button>
        {open ? (
          <div className={styles.menu} role="menu">
            <p className={styles.menuWallet}>{wallet?.adapter.name ?? 'Wallet'}</p>
            <button
              type="button"
              className={styles.menuItem}
              onClick={() => {
                void disconnect();
                setOpen(false);
              }}
            >
              Disconnect
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={styles.wrap} ref={menuRef}>
      <button
        type="button"
        className={styles.connect}
        onClick={() => setOpen((v) => !v)}
        disabled={connecting}
      >
        {connecting ? 'Connecting…' : 'Connect wallet'}
      </button>
      {open ? (
        <div className={styles.menu} role="menu">
          {installed.length === 0 ? (
            <p className={styles.empty}>
              No Solana wallet found. Install{' '}
              <a href="https://phantom.app" target="_blank" rel="noreferrer">
                Phantom
              </a>{' '}
              or{' '}
              <a href="https://solflare.com" target="_blank" rel="noreferrer">
                Solflare
              </a>
              .
            </p>
          ) : (
            installed.map((entry) => (
              <button
                key={entry.adapter.name}
                type="button"
                className={styles.menuItem}
                onClick={() => void pick(entry.adapter.name)}
              >
                {entry.adapter.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={entry.adapter.icon} alt="" className={styles.menuIcon} />
                ) : null}
                {entry.adapter.name}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

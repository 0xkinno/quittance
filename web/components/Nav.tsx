'use client';

/**
 * The navigation bar.
 *
 * A judge arriving cold needs to know in one glance that there is more here
 * than a pitch: a working demo, the evidence, and the program on chain. Without
 * it the page is a dead end that happens to scroll.
 *
 * It stays out of the way — a hairline on paper that only gains a background
 * once the hero is behind you, so it never competes with the headline.
 */

import { useEffect, useState } from 'react';

import { EXPLORER_PROGRAM_URL } from '@/lib/config';

import { WalletButton } from './WalletButton';

const LINKS = [
  { href: '/#demo', label: 'See it work' },
  { href: '/#how', label: 'How it resolves' },
  { href: '/#proof', label: 'Proof' },
  { href: '/#live', label: 'Try it live' },
  { href: '/proof', label: 'Verify' },
] as const;

const EXPLORER = EXPLORER_PROGRAM_URL;

export function Nav(): React.JSX.Element {
  const [lifted, setLifted] = useState(false);

  useEffect(() => {
    const onScroll = (): void => setLifted(window.scrollY > 80);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={`qnav${lifted ? ' qnav-lifted' : ''}`} data-testid="nav">
      <div className="shell qnav-inner">
        <a href="/" className="qnav-mark" aria-label="Quittance, home">
          Quittance
        </a>

        <nav aria-label="Primary">
          <ul className="qnav-links">
            {LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href}>{link.label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="qnav-right">
          <a className="qnav-cta" href={EXPLORER} target="_blank" rel="noreferrer">
            On devnet
          </a>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}

import type { Metadata, Viewport } from 'next';
import './globals.css';

import { WalletProvider } from '@/components/WalletProvider';

export const metadata: Metadata = {
  title: 'Quittance — who paid, and who did not',
  description:
    'Quittance lets a savings circle collect every contribution on a phone that dies mid-payment and still know, with certainty, who paid and who did not.',
  applicationName: 'Quittance',
  openGraph: {
    title: 'Quittance',
    description:
      'A savings circle that collects every contribution on a phone that dies mid-payment and still knows who paid.',
    type: 'website',
  },
  icons: { icon: '/icon.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The paper ground, so the browser chrome does not flash white before the
  // first paint and then settle into the page's colour.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#EAEBE6' },
    { media: '(prefers-color-scheme: dark)', color: '#15181C' },
  ],
};

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="en">
      <body>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from 'next';
import './globals.css';

export const dynamic = 'force-dynamic';
import { Sidebar } from '@/components/sidebar';
import { MainContent } from '@/components/main-content';
import { ToastProvider } from '@/components/toast-provider';
import { SentryUserInit } from '@/components/sentry-user-init';
import { Barlow, Barlow_Condensed, JetBrains_Mono } from 'next/font/google';
import { cn, ConfirmProvider } from '@badminton/ui';

const barlow = Barlow({ subsets: ['latin'], variable: '--font-sans', weight: ['400','500','600','700'] });
const barlowCondensed = Barlow_Condensed({ subsets: ['latin'], variable: '--font-display', weight: ['400','600','700'] });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', weight: ['400','500','600','700'] });

export const metadata: Metadata = {
  title: 'SFU Badminton - Admin',
  description: 'Admin dashboard for SFU Badminton Club',
  // Public assets are served under the '/admin' basePath, and the metadata API
  // does not prepend basePath — so these URLs must include it explicitly.
  manifest: '/admin/manifest.json',
  icons: {
    icon: [
      { url: '/admin/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/admin/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/admin/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'SFU Admin',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafafa' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={cn('font-sans', barlow.variable, barlowCondensed.variable, jetbrainsMono.variable)}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          try {
            var t = localStorage.getItem('theme') || 'dark';
            var r = t === 'system'
              ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
              : t;
            document.documentElement.setAttribute('data-theme', r);
          } catch(e) { document.documentElement.setAttribute('data-theme', 'dark'); }
        `}} />
      </head>
      <body className="antialiased">
        <ToastProvider>
          <ConfirmProvider>
            <SentryUserInit playerId={null} />
            <Sidebar />
            <MainContent>
              {children}
            </MainContent>
          </ConfirmProvider>
        </ToastProvider>
        <script dangerouslySetInnerHTML={{ __html: `
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/admin/sw.js').catch(function() {});
          }
        `}} />
      </body>
    </html>
  );
}

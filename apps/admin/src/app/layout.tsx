import type { Metadata, Viewport } from 'next';
import './globals.css';

export const dynamic = 'force-dynamic';
import { Sidebar } from '@/components/sidebar';
import { getAuthenticatedExecOrAdmin } from '@/lib/supabase-server';
import { accessLevelFor } from '@/lib/permissions';
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
  // Assets serve from the subdomain root
  // does not prepend basePath — so these URLs must include it explicitly.
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
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
  // Resolve the access level HERE, on the server, so the sidebar's first paint
  // is already correct. It used to fetch this itself in a useEffect and render
  // every nav item until the RPC came back — so an exec watched the admin-only
  // sections sit there for the length of a round-trip and then vanish. Choosing
  // between a flash of too much and a flash of an empty nav was a false choice:
  // the layout is already an async server component and can just know.
  //
  // Throws on public routes (/login, /unauthorized) where there is no session,
  // which is exactly when the sidebar renders nothing anyway.
  let initialAccessLevel = null;
  try {
    initialAccessLevel = accessLevelFor(await getAuthenticatedExecOrAdmin({ skipPasskey: true }));
  } catch {
    initialAccessLevel = null;
  }

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
            <Sidebar initialAccessLevel={initialAccessLevel} />
            <MainContent>
              {children}
            </MainContent>
          </ConfirmProvider>
        </ToastProvider>
        <script dangerouslySetInnerHTML={{ __html: `
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').catch(function() {});
          }
        `}} />
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from 'next';
import './globals.css';

export const dynamic = 'force-dynamic';
import { Sidebar } from '@/components/sidebar';
import { getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import { accessLevelFor, portfolioOf, type AccessLevel, type Portfolio } from '@/lib/permissions';
import { MainContent } from '@/components/main-content';
import { ToastProvider } from '@/components/toast-provider';
import { SentryUserInit } from '@/components/sentry-user-init';
import { Barlow, Barlow_Condensed, JetBrains_Mono } from 'next/font/google';
import { cn, ConfirmProvider } from '@badminton/ui';
import { withBase } from '@/lib/base-path';

const barlow = Barlow({ subsets: ['latin'], variable: '--font-sans', weight: ['400','500','600','700'] });
const barlowCondensed = Barlow_Condensed({ subsets: ['latin'], variable: '--font-display', weight: ['400','600','700'] });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', weight: ['400','500','600','700'] });

export const metadata: Metadata = {
  title: 'SFU Badminton - Admin',
  description: 'Admin dashboard for SFU Badminton Club',
  // Next prepends basePath to <Link>, redirect() and the router, but NOT to
  // metadata.manifest or metadata.icons — those emit whatever string they are
  // given. The console shares the player app's origin, so an unprefixed
  // "/manifest.json" is not a 404, it is the MEMBERS' manifest: an exec doing
  // Add to Home Screen from /admin got the members' app name and icon, and
  // launching it opened /feed. Hence withBase() on every one of these.
  //
  // public/manifest.json itself uses RELATIVE members (scope "./", start_url
  // "dashboard", icon "icon-192.png"). A manifest's URLs resolve against the
  // manifest's own address, so one file is correct both here — served at
  // /admin/manifest.json, giving scope /admin/ and start_url /admin/dashboard —
  // and on a root-mounted localhost build, where basePath is ''. A static file
  // cannot read BASE_PATH, and hard-coding /admin into it would break localhost.
  manifest: withBase('/manifest.json'),
  icons: {
    icon: [
      { url: withBase('/icon-192.png'), sizes: '192x192', type: 'image/png' },
      { url: withBase('/icon-512.png'), sizes: '512x512', type: 'image/png' },
    ],
    apple: withBase('/apple-touch-icon.png'),
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
  //
  // The exec portfolio is seeded from the same row for the same reason: the nav
  // is filtered on both axes, and a first paint that knew the level but not the
  // portfolio would show a narrowed exec every section and then take them away.
  let initialAccessLevel: AccessLevel | null = null;
  let initialPortfolio: Portfolio | null = null;
  try {
    const viewer = await getAuthenticatedConsoleUser({ skipPasskey: true });
    initialAccessLevel = accessLevelFor(viewer);
    initialPortfolio = portfolioOf(viewer);
  } catch {
    initialAccessLevel = null;
    initialPortfolio = null;
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
            <Sidebar initialAccessLevel={initialAccessLevel} initialPortfolio={initialPortfolio} />
            <MainContent>
              {children}
            </MainContent>
          </ConfirmProvider>
        </ToastProvider>
        {/*
          The console deliberately registers NO service worker.

          It used to register '/sw.js' from a dangerouslySetInnerHTML string,
          which Next cannot rewrite — so on the shared origin that was the
          PLAYER app's service worker, installed at scope '/' for execs who may
          never open the members' app. apps/admin/public/sw.js was dead code and
          has been deleted with this change.

          The console does not get its own worker either, and the reason is the
          push schema, not tidiness: push_subscriptions has no scope column, and
          sendPushToPlayers() fans a payload out to EVERY active row for a
          player_id. A second registration at scope '/admin/' would mean a
          second endpoint for the same device, so every member notification
          would fire twice on an exec's phone — one copy rendered by each
          worker. Two workers would also fight over caches (each activate
          handler deletes every cache but its own) and would re-introduce the
          /admin caching that apps/player/public/sw.js refuses on purpose, so a
          shared phone cannot hand back another exec's console view offline.

          Admin-targeted push therefore rides the one root worker, which honours
          the payload's `url`. See the notificationclick handler there.

          We do NOT unregister '/sw.js' from here: for the many execs who are
          also members that is their real player-app worker.
        */}
      </body>
    </html>
  );
}

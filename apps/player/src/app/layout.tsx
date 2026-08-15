import type { Metadata, Viewport } from 'next';
import './globals.css';

export const dynamic = 'force-dynamic';
import { BottomNav } from '@/components/bottom-nav';
import { TopBar } from '@/components/top-bar';
import { ToastProvider } from '@/components/toast-provider';
import { OfflineBanner } from '@/components/OfflineBanner';
import { WaiverGate } from '@/components/waiver-gate';
import { DeletionGate } from '@/components/deletion-gate';
import { PostHogProvider } from '@/components/posthog-provider';
import { PostHogIdentify } from '@/components/posthog-identify';
import { SentryUserInit } from '@/components/sentry-user-init';
import { StandingProvider } from '@/components/standing-provider';
import { StandingBanner } from '@/components/standing-banner';
import { cookies } from 'next/headers';
import { getMissingLegalDocuments, hasConsoleAccess, getAccountStanding, type AccountStanding } from '@badminton/shared';
import { createServiceRoleClient, createServerSupabaseClient, getActiveSeason } from '@/lib/supabase-server';
import localFont from "next/font/local";
import { cn } from "@/lib/utils";
import { ConfirmProvider, StaleBuildBanner } from "@badminton/ui";

// SELF-HOSTED, NOT next/font/google — and that is a deploy property, not a
// preference. next/font/google resolves at BUILD time: `docker build` opens a
// socket to fonts.gstatic.com, so a blip on the CI runner's network fails the
// image rather than the page. It already has. These are the exact same bytes —
// every file under src/fonts/ is sha256-identical to the one gstatic serves for
// that family, weight and subset today — vendored with their OFL 1.1 licences,
// so the build reads the disk and nothing else.
//
// Google's stylesheet does not ship one file per weight — it ships three,
// latin / latin-ext / vietnamese, sharing one font-family name and separated by
// unicode-range. localFont() cannot express that shape: every call mints its
// own private family, and the files inside one `src` array all land on that
// family with no unicode-range, so the last one listed would simply win and the
// rest would never paint. Hence one call per subset, chained back together into
// a single stack in globals.css:
//
//   --font-sans: var(--font-sans-ext), var(--font-sans-vi), var(--font-sans-latin)
//
// Order is load-bearing. The ext/vi faces carry a `unicode-range`, so they
// decline every codepoint outside their block and ordinary text still reaches
// the latin file. They must sit BEFORE it because `--font-sans-latin` ends in
// next/font's metric-matched Arial fallback, and Arial has ř and ế — listed
// after it, the subsets would never be consulted, which is the bug being fixed.
//
// preload:false on the subsets is deliberate: a roster with no accented name
// must not pay for them. A browser fetches a font only once a character it
// claims is actually painted, so those two files cost nothing until a Nguyễn
// or a Dvořák appears. adjustFontFallback:false keeps a second Arial fallback
// out of the middle of the stack; the latin call at the end supplies the one.
//
// The unicode-range values are verbatim from fonts.googleapis.com's css2 output
// for Barlow v13 and must be written inline — next/font rejects a reference
// ("Font loader values must be explicitly written literals"). Where the blocks
// overlap (U+0304, U+0308, U+0329) ext answers where Google gave it to latin:
// same family, same weight, same outline.
//
// JetBrains Mono stays latin-only. It sets labels, dates and figures, never a
// person's name. It is also a VARIABLE font: one file serves all four weights,
// which is exactly what Google's CSS did (four @font-face rules, one src).
const barlow = localFont({
  src: [
    { path: '../fonts/barlow-latin-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/barlow-latin-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/barlow-latin-600.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/barlow-latin-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-sans-latin',
  display: 'swap',
});
const barlowExt = localFont({
  src: [
    { path: '../fonts/barlow-latin-ext-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/barlow-latin-ext-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/barlow-latin-ext-600.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/barlow-latin-ext-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-sans-ext',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF' }],
});
const barlowVietnamese = localFont({
  src: [
    { path: '../fonts/barlow-vietnamese-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/barlow-vietnamese-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/barlow-vietnamese-600.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/barlow-vietnamese-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-sans-vi',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB' }],
});
const barlowCondensed = localFont({
  src: [
    { path: '../fonts/barlow-condensed-latin-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/barlow-condensed-latin-600.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/barlow-condensed-latin-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-display-latin',
  display: 'swap',
});
const barlowCondensedExt = localFont({
  src: [
    { path: '../fonts/barlow-condensed-latin-ext-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/barlow-condensed-latin-ext-600.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/barlow-condensed-latin-ext-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-display-ext',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF' }],
});
const barlowCondensedVietnamese = localFont({
  src: [
    { path: '../fonts/barlow-condensed-vietnamese-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/barlow-condensed-vietnamese-600.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/barlow-condensed-vietnamese-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-display-vi',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB' }],
});
const jetbrainsMono = localFont({
  src: [
    { path: '../fonts/jetbrains-mono-latin-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/jetbrains-mono-latin-400.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/jetbrains-mono-latin-400.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/jetbrains-mono-latin-400.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'SFU Badminton Club',
  description: 'Challenge, compete, and climb the ranks',
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
    title: 'SFU Badminton',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafafa' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let playerName = '';
  let avatarUrl: string | null = null;
  let isAuthenticated = false;
  let playerId: string | null = null;
  let playerStatus: string | null = null;
  let singlesElo: number | null = null;
  let doublesElo: number | null = null;
  let unreadCount = 0;
  let activeSeasonName = '';
  let missingLegalDocs: string[] = [];
  let deletionRequestedAt: string | null = null;
  let isExecOrAdmin = false;
  // Published to every client control via StandingProvider so none of them has
  // to re-derive it (or, as before, offer a button the server is certain to
  // refuse). Defaults to good standing, which is what a signed-out visitor is.
  let standing: AccountStanding = getAccountStanding(null);

  try {
    activeSeasonName = (await getActiveSeason())?.name ?? '';
  } catch {
    // No active season
  }

  // Theme preference lives in a cookie so we can set data-theme server-side and
  // avoid a flash of the wrong theme. Explicit light/dark render correctly on
  // the server; 'system' (or no cookie) defaults to dark and the inline script
  // below resolves the OS preference before paint.
  const themePref = (await cookies()).get('theme')?.value;
  const initialTheme = themePref === 'light' ? 'light' : 'dark';

  try {
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      isAuthenticated = true;
      // Reads deletion_requested_at / waiver_reset_at, which 00032 no longer
      // exposes to `authenticated`. Server-side and filtered by the session's
      // user id, so the service role is scoped to the caller's own row.
      const { data: player } = await createServiceRoleClient()
        .from('players')
        // is_banned has to be in the select or getAccountStanding reads it as
        // undefined and a banned member keeps every control — exactly the bug
        // this exists to fix. Same for active_flag + deletion_requested_at,
        // which getAccountStanding now reads too (and which hasConsoleAccess
        // and DeletionGate already needed). ban_reason is what lets the banner
        // say WHY rather than just "suspended".
        .select('id, full_name, avatar_url, status, is_banned, ban_reason, active_flag, role, is_exec, is_trainer, deletion_requested_at, waiver_reset_at, ratings(singles_elo, doubles_elo), waiver_acceptances(document, version, accepted_at)')
        .eq('user_id', user.id)
        .maybeSingle();
      standing = getAccountStanding(player);
      playerName = player?.full_name ?? '';
      avatarUrl = player?.avatar_url ?? null;
      playerId = player?.id ?? null;
      playerStatus = player?.status ?? null;
      deletionRequestedAt = player?.deletion_requested_at ?? null;
      // Anyone with ANY console level, which now includes varsity trainers —
      // the link in the top bar is the only route they have to the console, and
      // hiding it would leave the new role technically working and practically
      // unreachable.
      //
      // hasConsoleAccess is the shared predicate (@badminton/shared), the same
      // one the settings page and the admin app use, mirroring
      // admin_access_level() in 00057: standing first, then level. A banned or
      // deactivated exec is shown no route in — the console would reject them
      // anyway, and a link that always errors is worse than no link. Every
      // column it reads has to be in the select above, or it reads as undefined
      // and the link silently disappears.
      isExecOrAdmin = hasConsoleAccess(player);

      // A member needs the waiver gate when any of the four legal documents
      // lacks a valid acceptance — current version, and for the waiver also
      // re-signed within the last year (four tiny rows — skipped when no player).
      if (player) {
        const { data: docs } = await supabase
          .from('legal_documents')
          .select('document, version, reacceptance_required_since');
        const acceptances = (player.waiver_acceptances ?? []) as { document: string; version: string; accepted_at: string }[];
        missingLegalDocs = getMissingLegalDocuments(docs ?? [], acceptances, new Date(), player.waiver_reset_at);
      }

      const ratings = Array.isArray(player?.ratings) ? player.ratings[0] : player?.ratings;
      singlesElo = (ratings as Record<string, unknown>)?.singles_elo as number ?? null;
      doublesElo = (ratings as Record<string, unknown>)?.doubles_elo as number ?? null;

      const { count } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('player_id', player?.id ?? '')
        .eq('read_flag', false);
      unreadCount = count ?? 0;
    }
  } catch {
    // Not authenticated
  }

  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-theme={initialTheme}
      className={cn(
        "font-sans",
        // All six Barlow variables have to land on the same element: globals.css
        // composes --font-sans/--font-display out of them at :root, which IS
        // this <html>, and a var() that resolves to nothing there would
        // invalidate the whole font-family it sits in.
        barlow.variable, barlowExt.variable, barlowVietnamese.variable,
        barlowCondensed.variable, barlowCondensedExt.variable, barlowCondensedVietnamese.variable,
        jetbrainsMono.variable,
      )}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          try {
            var m = document.cookie.match(/(?:^|; )theme=([^;]+)/);
            var t = (m && decodeURIComponent(m[1])) || localStorage.getItem('theme') || 'dark';
            var r = t === 'system'
              ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
              : t;
            document.documentElement.setAttribute('data-theme', r);
          } catch(e) { document.documentElement.setAttribute('data-theme', 'dark'); }
        `}} />
      </head>
      <body>
        {/* Outside every provider on purpose. It needs none of them, it must
            reach a member who is stuck behind WaiverGate or DeletionGate, and
            the fetch wrapper it installs should be in place before anything
            below has a handler that could fire a server action. */}
        <StaleBuildBanner />
        <PostHogProvider>
          <ToastProvider>
            <ConfirmProvider>
              <StandingProvider standing={standing}>
                <SentryUserInit playerId={playerId} />
                <PostHogIdentify
                  playerId={playerId}
                  playerStatus={playerStatus}
                  singlesElo={singlesElo}
                  doublesElo={doublesElo}
                />
                <OfflineBanner />
                <DeletionGate deletionRequestedAt={deletionRequestedAt} />
                {/* Deletion screen wins when both gates would apply. */}
                <WaiverGate missingDocs={deletionRequestedAt ? [] : missingLegalDocs} />
                <TopBar isApproved={playerStatus !== 'pending_approval' && playerStatus !== 'suspended'} playerName={playerName} avatarUrl={avatarUrl} unreadCount={unreadCount} isAuthenticated={isAuthenticated} isExecOrAdmin={isExecOrAdmin} activeSeasonName={activeSeasonName} />
                {/* Under the top bar, above the page: the one place that says
                    why the controls below are missing. Nav gating is left as
                    it was — a link that still loads its page is not a control
                    the server refuses, and the per-surface notes need those
                    pages to stay reachable. */}
                <StandingBanner />
                <main className="page pb-safe-nav">
                  {children}
                </main>
                <BottomNav isAuthenticated={isAuthenticated} isApproved={playerStatus !== 'pending_approval' && playerStatus !== 'suspended'} />
              </StandingProvider>
            </ConfirmProvider>
          </ToastProvider>
        </PostHogProvider>
        <script dangerouslySetInnerHTML={{ __html: `
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').catch(function() {});
          }
        `}} />
      </body>
    </html>
  );
}

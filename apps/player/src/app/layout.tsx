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
import { cookies } from 'next/headers';
import { getMissingLegalDocuments } from '@badminton/shared';
import { createServiceRoleClient, createServerSupabaseClient, getActiveSeason } from '@/lib/supabase-server';
import { Barlow, Barlow_Condensed, JetBrains_Mono } from "next/font/google";
import { cn } from "@/lib/utils";
import { ConfirmProvider } from "@badminton/ui";

const barlow = Barlow({ subsets: ['latin'], variable: '--font-sans', weight: ['400','500','600','700'] });
const barlowCondensed = Barlow_Condensed({ subsets: ['latin'], variable: '--font-display', weight: ['400','600','700'] });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', weight: ['400','500','600','700'] });

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
        .select('id, full_name, avatar_url, status, role, is_exec, is_trainer, deletion_requested_at, waiver_reset_at, ratings(singles_elo, doubles_elo), waiver_acceptances(document, version, accepted_at)')
        .eq('user_id', user.id)
        .maybeSingle();
      playerName = player?.full_name ?? '';
      avatarUrl = player?.avatar_url ?? null;
      playerId = player?.id ?? null;
      playerStatus = player?.status ?? null;
      deletionRequestedAt = player?.deletion_requested_at ?? null;
      // Anyone with ANY console level, which now includes varsity trainers —
      // the link in the top bar is the only route they have to the console, and
      // hiding it would leave the new role technically working and practically
      // unreachable. Same predicate as admin_access_level(); is_trainer has to
      // be in the select above too, or it reads as undefined and silently
      // hides the link.
      isExecOrAdmin = !!(player?.is_exec || player?.is_trainer || player?.role === 'admin');

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
      className={cn("font-sans", barlow.variable, barlowCondensed.variable, jetbrainsMono.variable)}
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
        <PostHogProvider>
          <ToastProvider>
            <ConfirmProvider>
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
              <main className="page pb-safe-nav">
                {children}
              </main>
              <BottomNav isAuthenticated={isAuthenticated} isApproved={playerStatus !== 'pending_approval' && playerStatus !== 'suspended'} />
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

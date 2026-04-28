import type { Metadata } from 'next';
import './globals.css';
import { BottomNav } from '@/components/bottom-nav';
import { TopBar } from '@/components/top-bar';
import { ToastProvider } from '@/components/toast-provider';
import { OfflineBanner } from '@/components/OfflineBanner';
import { PostHogProvider } from '@/components/posthog-provider';
import { PostHogIdentify } from '@/components/posthog-identify';
import { SentryUserInit } from '@/components/sentry-user-init';
import { QrRedirectHandler } from '@/components/qr-redirect-handler';
import { NotificationCountsProvider } from '@/components/notification-badges';
import { SWRProvider } from '@/components/swr-provider';
import { ProfileProvider, type Profile } from '@/components/profile-provider';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { DM_Sans } from "next/font/google";
import { headers } from 'next/headers';
import { cn } from "@/lib/utils";

const dmSans = DM_Sans({subsets:['latin'],variable:'--font-sans',weight:['400','500','600','700']});

export const metadata: Metadata = {
  title: 'SFU Badminton Club',
  description: 'Challenge, compete, and climb the ranks',
  manifest: '/manifest.json',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let playerName = '';
  let playerId: string | null = null;
  let playerStatus: string | null = null;
  let avatarUrl: string | null = null;
  let singlesElo: number | null = null;
  let doublesElo: number | null = null;

  try {
    // Middleware already authed and set x-user-id on the request headers —
    // read it here to skip a redundant auth.getUser() round-trip.
    const userId = headers().get('x-user-id');
    if (userId) {
      const supabase = await createServerSupabaseClient();
      const { data: player } = await supabase
        .from('players')
        .select('id, full_name, avatar_url, status, ratings(singles_elo, doubles_elo)')
        .eq('user_id', userId)
        .single();
      playerName = player?.full_name ?? '';
      playerId = player?.id ?? null;
      playerStatus = player?.status ?? null;
      avatarUrl = (player as { avatar_url?: string | null })?.avatar_url ?? null;

      const ratings = Array.isArray(player?.ratings) ? player.ratings[0] : player?.ratings;
      singlesElo = (ratings as Record<string, unknown>)?.singles_elo as number ?? null;
      doublesElo = (ratings as Record<string, unknown>)?.doubles_elo as number ?? null;
    }
  } catch {
    // Not authenticated
  }

  const initialProfile: Profile = playerId
    ? {
        id: playerId,
        full_name: playerName,
        avatar_url: avatarUrl,
        status: playerStatus,
        singles_elo: singlesElo,
        doubles_elo: doublesElo,
      }
    : null;

  return (
    <html lang="en" suppressHydrationWarning data-theme="dark" className={cn("font-sans", dmSans.variable)}>
      <head>
        <meta name="theme-color" content="#0A0E1A" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
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
      <body>
        <SWRProvider>
          <ProfileProvider initial={initialProfile}>
            <PostHogProvider>
              <ToastProvider>
                <SentryUserInit playerId={playerId} />
                <QrRedirectHandler isAuthed={!!playerId} />
                <PostHogIdentify
                  playerId={playerId}
                  playerStatus={playerStatus}
                  singlesElo={singlesElo}
                  doublesElo={doublesElo}
                />
                <NotificationCountsProvider isAuthed={!!playerId}>
                  <OfflineBanner />
                  <TopBar />
                  <main className="max-w-7xl mx-auto px-4 py-6 pb-24 md:pb-6">
                    {children}
                  </main>
                  <BottomNav />
                </NotificationCountsProvider>
              </ToastProvider>
            </PostHogProvider>
          </ProfileProvider>
        </SWRProvider>
        <script dangerouslySetInnerHTML={{ __html: `
          if ('serviceWorker' in navigator) {
            // Defer SW registration off the critical path so it doesn't block
            // hydration on slow mobile networks.
            window.addEventListener('load', function() {
              navigator.serviceWorker.register('/sw.js').catch(function() {});
            });
          }
        `}} />
      </body>
    </html>
  );
}

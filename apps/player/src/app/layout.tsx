import type { Metadata } from 'next';
import './globals.css';

export const dynamic = 'force-dynamic';
import { BottomNav } from '@/components/bottom-nav';
import { TopBar } from '@/components/top-bar';
import { ToastProvider } from '@/components/toast-provider';
import { OfflineBanner } from '@/components/OfflineBanner';
import { PostHogProvider } from '@/components/posthog-provider';
import { PostHogIdentify } from '@/components/posthog-identify';
import { SentryUserInit } from '@/components/sentry-user-init';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { DM_Sans } from "next/font/google";
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
  let singlesElo: number | null = null;
  let doublesElo: number | null = null;
  let unreadCount = 0;

  try {
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: player } = await supabase
        .from('players')
        .select('id, full_name, status, ratings(singles_elo, doubles_elo)')
        .eq('user_id', user.id)
        .single();
      playerName = player?.full_name ?? '';
      playerId = player?.id ?? null;
      playerStatus = player?.status ?? null;

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
    <html lang="en" suppressHydrationWarning className={cn("font-sans", dmSans.variable)}>
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
        <PostHogProvider>
          <ToastProvider>
            <SentryUserInit playerId={playerId} />
            <PostHogIdentify
              playerId={playerId}
              playerStatus={playerStatus}
              singlesElo={singlesElo}
              doublesElo={doublesElo}
            />
            <OfflineBanner />
            <TopBar playerName={playerName} unreadCount={unreadCount} />
            <main className="max-w-7xl mx-auto px-4 py-6 pb-24 md:pb-6">
              {children}
            </main>
            <BottomNav />
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

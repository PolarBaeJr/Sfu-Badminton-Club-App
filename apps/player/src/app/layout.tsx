import type { Metadata, Viewport } from 'next';
import './globals.css';

export const dynamic = 'force-dynamic';
import { BottomNav } from '@/components/bottom-nav';
import { TopBar } from '@/components/top-bar';
import { ToastProvider } from '@/components/toast-provider';
import { OfflineBanner } from '@/components/OfflineBanner';
import { PostHogProvider } from '@/components/posthog-provider';
import { PostHogIdentify } from '@/components/posthog-identify';
import { SentryUserInit } from '@/components/sentry-user-init';
import { cookies } from 'next/headers';
import { createServerSupabaseClient, getActiveSeason } from '@/lib/supabase-server';
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { cn } from "@/lib/utils";

const inter = Inter({ subsets: ['latin'], variable: '--font-sans', weight: ['400','500','600','700'] });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-display', weight: ['400','500','600','700'] });
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
    { media: '(prefers-color-scheme: light)', color: '#F8FAFC' },
    { media: '(prefers-color-scheme: dark)', color: '#0B0F1A' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let playerName = '';
  let isAuthenticated = false;
  let playerId: string | null = null;
  let playerStatus: string | null = null;
  let singlesElo: number | null = null;
  let doublesElo: number | null = null;
  let unreadCount = 0;
  let activeSeasonName = '';

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
      const { data: player } = await supabase
        .from('players')
        .select('id, full_name, status, ratings(singles_elo, doubles_elo)')
        .eq('user_id', user.id)
        .maybeSingle();
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
    <html
      lang="en"
      suppressHydrationWarning
      data-theme={initialTheme}
      className={cn("font-sans", inter.variable, spaceGrotesk.variable, jetbrainsMono.variable)}
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
            <SentryUserInit playerId={playerId} />
            <PostHogIdentify
              playerId={playerId}
              playerStatus={playerStatus}
              singlesElo={singlesElo}
              doublesElo={doublesElo}
            />
            <OfflineBanner />
            <TopBar playerName={playerName} unreadCount={unreadCount} isAuthenticated={isAuthenticated} activeSeasonName={activeSeasonName} />
            <main className="page pb-safe-nav">
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

import type { Metadata } from 'next';
import './globals.css';
import { BottomNav } from '@/components/bottom-nav';
import { DesktopSidebar } from '@/components/desktop-sidebar';
import { ToastProvider } from '@/components/toast-provider';
import { OfflineBanner } from '@/components/OfflineBanner';
import { PostHogProvider } from '@/components/posthog-provider';
import { PostHogIdentify } from '@/components/posthog-identify';
import { SentryUserInit } from '@/components/sentry-user-init';
import { QrRedirectHandler } from '@/components/qr-redirect-handler';
import { NotificationCountsProvider } from '@/components/notification-badges';
import { SWRProvider } from '@/components/swr-provider';
import { ProfileProvider, type Profile } from '@/components/profile-provider';
import { StatusBar } from '@/components/v2/atoms';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { headers } from 'next/headers';

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'SFU Badminton — Player',
  description: 'ELO that moves with every match.',
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
      singlesElo = ((ratings as Record<string, unknown>)?.singles_elo as number) ?? null;
      doublesElo = ((ratings as Record<string, unknown>)?.doubles_elo as number) ?? null;
    }
  } catch {
    // not authed
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

  const isAuthed = !!playerId;

  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${jetbrains.variable}`}>
      <head>
        <meta name="theme-color" content="#0d0d0d" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body suppressHydrationWarning>
        <SWRProvider>
          <ProfileProvider initial={initialProfile}>
            <PostHogProvider>
              <ToastProvider>
                <SentryUserInit playerId={playerId} />
                <QrRedirectHandler isAuthed={isAuthed} />
                <PostHogIdentify
                  playerId={playerId}
                  playerStatus={playerStatus}
                  singlesElo={singlesElo}
                  doublesElo={doublesElo}
                />
                <NotificationCountsProvider isAuthed={isAuthed}>
                  <OfflineBanner />
                  <PhoneFrame showChrome={isAuthed}>{children}</PhoneFrame>
                </NotificationCountsProvider>
              </ToastProvider>
            </PostHogProvider>
          </ProfileProvider>
        </SWRProvider>
        <script
          dangerouslySetInnerHTML={{
            __html: `if ('serviceWorker' in navigator) { window.addEventListener('load', function() { navigator.serviceWorker.register('/sw.js').catch(function() {}); }); }`,
          }}
        />
      </body>
    </html>
  );
}

function PhoneFrame({ children, showChrome }: { children: React.ReactNode; showChrome: boolean }) {
  // Auth pages (login/onboarding) opt out via AuthShell.
  if (!showChrome) {
    return <>{children}</>;
  }
  // <1024px: phone-frame chrome (StatusBar + scroll + BottomNav).
  // ≥1024px: .stage/.device/.device-screen/.scroll-mobile become display:contents,
  // .m-only items hide, DesktopSidebar shows, and the d-main-wrap gets a 220px
  // left margin to clear the fixed sidebar. Children render exactly once.
  return (
    <>
      <DesktopSidebar />
      <div className="stage">
        <div className="device">
          <div className="notch m-only" />
          <div className="device-screen">
            <div className="m-only">
              <StatusBar />
            </div>
            <div className="scroll scroll-mobile">
              <main className="d-main-wrap">
                {children}
                <div style={{ height: 24 }} className="m-only" />
              </main>
            </div>
            <div className="m-only">
              <BottomNav />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

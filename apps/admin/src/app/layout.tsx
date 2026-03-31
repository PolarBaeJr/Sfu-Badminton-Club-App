import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/sidebar';
import { ToastProvider } from '@/components/toast-provider';
import { SentryUserInit } from '@/components/sentry-user-init';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export const metadata: Metadata = {
  title: 'SFU Badminton - Admin',
  description: 'Admin dashboard for SFU Badminton Club',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let playerId: string | null = null;

  try {
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: player } = await supabase
        .from('players')
        .select('id')
        .eq('user_id', user.id)
        .single();
      playerId = player?.id ?? null;
    }
  } catch {
    // Not authenticated
  }

  return (
    <html lang="en" suppressHydrationWarning>
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
          <SentryUserInit playerId={playerId} />
          <Sidebar />
          <main className="ml-64 min-h-screen p-6 lg:p-8 transition-all duration-300">
            <div className="max-w-7xl mx-auto">
              {children}
            </div>
          </main>
        </ToastProvider>
      </body>
    </html>
  );
}

import type { Metadata } from 'next';
import './globals.css';

export const dynamic = 'force-dynamic';
import { Sidebar } from '@/components/sidebar';
import { MainContent } from '@/components/main-content';
import { ToastProvider } from '@/components/toast-provider';
import { SentryUserInit } from '@/components/sentry-user-init';
import { Inter, Space_Grotesk, JetBrains_Mono } from 'next/font/google';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans', weight: ['400','500','600','700'] });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-display', weight: ['400','500','600','700'] });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', weight: ['400','500','600','700'] });

export const metadata: Metadata = {
  title: 'SFU Badminton - Admin',
  description: 'Admin dashboard for SFU Badminton Club',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`font-sans ${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          try {
            var t = localStorage.getItem('theme') || 'light';
            var r = t === 'system'
              ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
              : t;
            document.documentElement.setAttribute('data-theme', r);
          } catch(e) { document.documentElement.setAttribute('data-theme', 'light'); }
        `}} />
      </head>
      <body className="antialiased">
        <ToastProvider>
          <SentryUserInit playerId={null} />
          <Sidebar />
          <MainContent>
            {children}
          </MainContent>
        </ToastProvider>
      </body>
    </html>
  );
}

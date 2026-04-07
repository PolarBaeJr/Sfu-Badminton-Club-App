import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/sidebar';
import { MainContent } from '@/components/main-content';
import { ToastProvider } from '@/components/toast-provider';
import { SentryUserInit } from '@/components/sentry-user-init';

export const metadata: Metadata = {
  title: 'SFU Badminton - Admin',
  description: 'Admin dashboard for SFU Badminton Club',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
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

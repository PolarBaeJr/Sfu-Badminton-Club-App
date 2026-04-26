'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

// Drains the sessionStorage 'qr_redirect' key set by /submit's AuthRedirect
// when the user was bounced through login. Only fires once the user is
// landed on an authed page (i.e. layout loaded a playerId) and not already
// on /submit. Mobile QR-scan flows often open the system browser separately
// from any in-app webview — this handler closes that gap.
export function QrRedirectHandler({ isAuthed }: { isAuthed: boolean }) {
  const pathname = usePathname();

  useEffect(() => {
    if (!isAuthed) return;
    if (pathname?.startsWith('/submit')) return;
    try {
      const target = sessionStorage.getItem('qr_redirect');
      if (target && target.startsWith('/submit')) {
        sessionStorage.removeItem('qr_redirect');
        window.location.replace(target);
      }
    } catch {
      // sessionStorage unavailable — nothing to do
    }
  }, [isAuthed, pathname]);

  return null;
}

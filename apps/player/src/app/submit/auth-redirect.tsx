'use client';

import { useEffect } from 'react';

// Not authenticated — stash the full QR URL so the login success handler
// can bounce the user back here after they sign in. Runs on mount.
export function AuthRedirect({ cid, tok }: { cid: string; tok: string }) {
  useEffect(() => {
    try {
      const url = `/submit?cid=${encodeURIComponent(cid)}&tok=${encodeURIComponent(tok)}`;
      sessionStorage.setItem('qr_redirect', url);
    } catch {
      // sessionStorage can throw in private-mode Safari — fallback to query param
    }
    const next = encodeURIComponent(`/submit?cid=${cid}&tok=${tok}`);
    window.location.replace(`/login?next=${next}`);
  }, [cid, tok]);

  return (
    <div
      style={{
        minHeight: '70vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
        Redirecting to sign in…
      </div>
    </div>
  );
}

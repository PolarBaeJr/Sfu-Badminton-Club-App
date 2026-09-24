'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import { routeErrorMessage } from '@badminton/ui';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif', background: '#0a0a0a', color: '#fafafa', margin: 0 }}>
        <div style={{ textAlign: 'center', padding: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ fontSize: 14, opacity: 0.7, marginBottom: error.digest ? 8 : 20 }}>{routeErrorMessage(error)}</p>
          {error.digest && (
            <p style={{ fontSize: 12, opacity: 0.6, marginBottom: 20 }}>
              Error code <span style={{ fontFamily: 'ui-monospace, monospace', userSelect: 'all' }}>{error.digest}</span>
            </p>
          )}
          <button onClick={() => reset()} style={{ padding: '8px 20px', borderRadius: 999, border: '1px solid #cc0000', background: '#cc0000', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Try again</button>
        </div>
      </body>
    </html>
  );
}

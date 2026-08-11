'use client';

import React, { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { AlertTriangle, RotateCw } from 'lucide-react';

interface RouteErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/** Default error.tsx component for app routes. Renders a centred column — a
 * red-wash exclamation disc, the error message, the digest and a reset button.
 * No card: every style below is inline and there is no surface, border or
 * .card-base anywhere in it. (The docstring used to claim a card-base, which
 * is why this says so explicitly.) Auto-logs digest to console for triage;
 * Sentry already auto-captures server component errors. */
export function RouteError({ error, reset }: RouteErrorProps) {
  useEffect(() => {
    Sentry.captureException(error);
    if (error?.digest) {
      // eslint-disable-next-line no-console
      console.error('Route error:', error.digest, error);
    }
  }, [error]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '64px 24px',
        textAlign: 'center',
        gap: 16,
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 999,
          background: 'var(--red-wash)',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <AlertTriangle size={26} style={{ color: 'var(--red)' }} />
      </div>
      <div>
        <h2
          style={{
            fontFamily: 'var(--display)',
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: '-.02em',
            margin: 0,
          }}
        >
          Something went wrong
        </h2>
        <p
          className="muted"
          style={{ fontSize: 14, margin: '8px 0 0', maxWidth: 480, lineHeight: 1.5 }}
        >
          {error?.message || 'This page failed to load.'}
        </p>
        {error?.digest && (
          <p className="mono muted" style={{ fontSize: 11, marginTop: 8 }}>
            Reference: {error.digest}
          </p>
        )}
      </div>
      <button type="button" onClick={reset} className="btn btn-primary">
        <RotateCw size={14} />
        Try again
      </button>
    </div>
  );
}

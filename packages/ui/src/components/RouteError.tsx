'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Card } from './Card';
import { ROUTE_ERROR_FALLBACK } from '../route-error';
// Deep import for the same reason as StaleBuildBanner: this is a client
// component and the shared barrel pulls server-only modules in.
import { describeError, type ErrorArea } from '@badminton/shared/src/utils/error-codes';

interface RouteErrorProps {
  title: string;
  error: Error & { digest?: string };
  reset: () => void;
  fallback?: string;
  /** Names a numeric digest `<area>-000`. A coded digest keeps its own code. */
  area?: ErrorArea;
  children?: React.ReactNode;
}

/** The body of every route error.tsx. Server errors show the fallback and an
 * error code: `CODE.ref`, whose code is documented in ERROR-CODES.md and whose
 * ref is what to grep the server log for. Reporting to Sentry is left to each
 * boundary. */
export function RouteError({ title, error, reset, fallback, area = 'GEN', children }: RouteErrorProps) {
  const described = describeError(error, area, fallback ?? ROUTE_ERROR_FALLBACK);
  const { code, ref, entry, copyText } = described;
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (copyText) {
      // eslint-disable-next-line no-console
      console.error('Route error:', copyText, error);
    }
  }, [copyText, error]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard over plain http; the code is still selectable.
    }
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-4">
      <Card className="max-w-md w-full text-center">
        <div className="w-16 h-16 rounded-full bg-[color-mix(in_oklab,var(--color-danger)_10%,transparent)] flex items-center justify-center mx-auto mb-4">
          <span className="text-2xl text-[var(--color-danger)]">!</span>
        </div>
        <h2 className="text-xl font-bold text-[var(--text-primary)] mb-2">{title}</h2>
        <p className={`text-[var(--text-muted)] text-sm ${code ? 'mb-3' : 'mb-6'}`}>
          {described.message}
        </p>
        {code && (
          <div className="mb-6 space-y-1">
            <p className="text-[var(--text-muted)] text-xs flex items-center justify-center gap-2">
              <span>Error code</span>
              <span className="font-mono select-all text-[var(--text-primary)]">{code}</span>
              <button
                type="button"
                onClick={copy}
                className="underline underline-offset-2 hover:text-[var(--text-primary)]"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </p>
            {entry && (
              <p className="text-[var(--text-muted)] text-xs">
                <span className="font-medium text-[var(--text-primary)]">{entry.title}.</span> {entry.meaning}
              </p>
            )}
            <p className="text-[var(--text-muted)] text-xs font-mono select-all opacity-70">ref {ref}</p>
          </div>
        )}
        <div className="flex gap-3 justify-center">
          <Button onClick={reset}>Try Again</Button>
          {children}
        </div>
      </Card>
    </div>
  );
}

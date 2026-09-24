'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Card } from './Card';
import { routeErrorMessage } from '../route-error';

interface RouteErrorProps {
  title: string;
  error: Error & { digest?: string };
  reset: () => void;
  fallback?: string;
  children?: React.ReactNode;
}

/** The body of every route error.tsx. Server errors show the fallback and
 * the digest, which Next prints next to the real error in the server log, so
 * an exec can report the code and it can be grepped. Reporting to Sentry is
 * left to each boundary. */
export function RouteError({ title, error, reset, fallback, children }: RouteErrorProps) {
  const digest = error?.digest;
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (digest) {
      // eslint-disable-next-line no-console
      console.error('Route error:', digest, error);
    }
  }, [digest, error]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    if (!digest) return;
    try {
      await navigator.clipboard.writeText(digest);
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
        <p className={`text-[var(--text-muted)] text-sm ${digest ? 'mb-3' : 'mb-6'}`}>
          {routeErrorMessage(error, fallback)}
        </p>
        {digest && (
          <p className="text-[var(--text-muted)] text-xs mb-6 flex items-center justify-center gap-2">
            <span>Error code</span>
            <span className="font-mono select-all text-[var(--text-primary)]">{digest}</span>
            <button
              type="button"
              onClick={copy}
              className="underline underline-offset-2 hover:text-[var(--text-primary)]"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </p>
        )}
        <div className="flex gap-3 justify-center">
          <Button onClick={reset}>Try Again</Button>
          {children}
        </div>
      </Card>
    </div>
  );
}

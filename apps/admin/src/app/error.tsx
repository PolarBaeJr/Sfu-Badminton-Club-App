'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import { Button, Card } from '@badminton/ui';

export default function Error({
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
    <div className="min-h-[60vh] flex items-center justify-center p-4">
      <Card className="max-w-md w-full text-center">
        <div className="w-16 h-16 rounded-full bg-[color-mix(in_oklab,var(--color-danger)_10%,transparent)] flex items-center justify-center mx-auto mb-4">
          <span className="text-2xl text-[var(--color-danger)]">!</span>
        </div>
        <h2 className="text-xl font-bold text-[var(--text-primary)] mb-2">Something went wrong</h2>
        <p className="text-[var(--text-muted)] text-sm mb-6">
          {error.message || 'An unexpected error occurred.'}
        </p>
        <Button onClick={reset} className="w-full">
          Try Again
        </Button>
      </Card>
    </div>
  );
}

'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import { RouteError } from '@badminton/ui';

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

  return <RouteError area="GEN" title="Something went wrong" error={error} reset={reset} />;
}

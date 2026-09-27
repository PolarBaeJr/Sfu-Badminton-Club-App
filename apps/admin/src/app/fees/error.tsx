'use client';

import { RouteError } from '@badminton/ui';

export default function FeesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError area="FEE" title="Fees Error" error={error} reset={reset} fallback="Failed to load fees." />
  );
}

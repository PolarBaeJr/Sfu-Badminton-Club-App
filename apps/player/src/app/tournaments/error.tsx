'use client';

import { RouteError } from '@badminton/ui';

export default function TournamentsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError title="Tournaments Error" error={error} reset={reset} fallback="Failed to load tournaments." />
  );
}

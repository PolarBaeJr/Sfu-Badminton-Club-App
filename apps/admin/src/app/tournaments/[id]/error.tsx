'use client';

import { Button, RouteError } from '@badminton/ui';

export default function TournamentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError title="Tournament Error" error={error} reset={reset} fallback="Failed to load tournament details.">
      <Button variant="secondary" onClick={() => window.history.back()}>
        Go Back
      </Button>
    </RouteError>
  );
}

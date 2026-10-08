'use client';

import { Button, RouteError } from '@badminton/ui';

export default function EventError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError area="TRN" title="Event Error" error={error} reset={reset} fallback="Failed to load event details.">
      <Button variant="secondary" onClick={() => window.history.back()}>
        Go Back
      </Button>
    </RouteError>
  );
}

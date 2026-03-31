'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

export function SentryUserInit({ playerId }: { playerId: string | null }) {
  useEffect(() => {
    if (playerId) {
      Sentry.setUser({ id: playerId });
    } else {
      Sentry.setUser(null);
    }
  }, [playerId]);

  return null;
}

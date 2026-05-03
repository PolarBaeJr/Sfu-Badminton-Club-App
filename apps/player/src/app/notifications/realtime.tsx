'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@badminton/shared/supabase-browser';

/**
 * Subscribes to INSERTs on the notifications table for the current player
 * and triggers a router.refresh() so the server-rendered inbox updates
 * without a manual reload. Renders nothing.
 *
 * Phase 7. Cleanup on unmount removes the channel; we filter by player_id
 * server-side so the realtime payload bandwidth stays small.
 */
export function NotificationsRealtime({ playerId }: { playerId: string }) {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`notifications:${playerId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `player_id=eq.${playerId}`,
        },
        () => router.refresh()
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [playerId, router]);

  return null;
}

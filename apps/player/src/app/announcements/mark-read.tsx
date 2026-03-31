'use client';

import { Button } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { markAllAnnouncementsRead } from './actions';
import { useState } from 'react';
import { getPostHogClient } from '@/lib/posthog';

export function MarkAllReadButton({ playerId }: { playerId: string }) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleMarkAll() {
    setLoading(true);
    try {
      await markAllAnnouncementsRead(playerId);
      const ph = getPostHogClient();
      if (ph) ph.capture('announcement_read', { player_id: playerId });
      toast('All marked as read', 'success');
    } catch {
      toast('Failed to mark as read', 'error');
    }
    setLoading(false);
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleMarkAll} loading={loading}>
      Mark all read
    </Button>
  );
}

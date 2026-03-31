'use client';

import { Button } from '@badminton/ui';
import { markAllNotificationsRead } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useState } from 'react';

export function NotificationActions() {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleMarkAll() {
    setLoading(true);
    try {
      await markAllNotificationsRead();
      toast('All marked as read', 'success');
    } catch (err) {
      toast('Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <Button size="sm" variant="ghost" onClick={handleMarkAll} loading={loading}>
      Mark All Read
    </Button>
  );
}

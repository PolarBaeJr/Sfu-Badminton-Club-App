'use client';

import { Button } from '@badminton/ui';
import { markAllNotificationsRead, markNotificationRead } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

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

export function NotificationLink({
  notificationId,
  href,
  isRead,
  children,
}: {
  notificationId: string;
  href: string | null;
  isRead: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();

  async function handleClick() {
    if (!isRead) {
      await markNotificationRead(notificationId);
    }
    if (href) {
      router.push(href);
    }
  }

  return (
    <div onClick={handleClick} className={href ? 'cursor-pointer' : ''}>
      {children}
    </div>
  );
}

'use client';

import { markAllNotificationsRead, markNotificationRead } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useState } from 'react';
import Link from 'next/link';

/**
 * The header's "mark all read".
 *
 * A plain button rather than the <Button> component: the mockup renders this as
 * a mono micro-caps text control sitting on the header baseline, and dressing a
 * bordered Button down to that costs more overrides than it saves. It is still
 * a real control — it calls the existing markAllNotificationsRead server
 * action, which guards with requirePlayer() and revalidates this path.
 */
export function MarkAllRead({ disabled }: { disabled?: boolean }) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleMarkAll() {
    setLoading(true);
    try {
      const res = await markAllNotificationsRead();
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
      toast('All marked as read', 'success');
    } catch {
      toast('Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <button
      type="button"
      className="notif-markall press"
      onClick={handleMarkAll}
      disabled={disabled || loading}
    >
      {loading ? 'Marking…' : 'Mark all read'}
    </button>
  );
}

/**
 * The row shell — one click target, three shapes.
 *
 * A row that has somewhere to go is a Link (marking read on the way out, so the
 * count is right when the member comes back). A row with nowhere to go but
 * still unread is a button whose only job is to mark it read. A row that is
 * read and has nowhere to go is inert markup, because a control that does
 * nothing when tapped is worse than no control.
 */
export function NotificationRow({
  id,
  isRead,
  href,
  children,
}: {
  id: string;
  isRead: boolean;
  href: string | null;
  children: React.ReactNode;
}) {
  const [marking, setMarking] = useState(false);
  const className = `notif-row${isRead ? ' read' : ' unread'}`;

  if (href) {
    return (
      <Link
        href={href}
        className={`${className} press`}
        onClick={() => {
          // Fire-and-forget: the navigation must not wait on the write, and the
          // action revalidates /notifications for when the member comes back.
          if (!isRead) void markNotificationRead(id);
        }}
      >
        {children}
      </Link>
    );
  }

  if (!isRead) {
    return (
      <button
        type="button"
        className={`${className} press`}
        disabled={marking}
        onClick={() => {
          // No matching setMarking(false): the action revalidates
          // /notifications, so this row comes back as read and this button
          // unmounts. Clearing the flag afterwards would be a state update on
          // a component that is gone.
          setMarking(true);
          void markNotificationRead(id);
        }}
      >
        {children}
      </button>
    );
  }

  return <div className={className}>{children}</div>;
}

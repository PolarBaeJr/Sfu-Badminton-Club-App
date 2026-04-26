'use client';

import { useEffect, useRef } from 'react';
import { markAnnouncementRead } from '@/lib/actions';
import { formatRelativeTime } from '@badminton/shared';
import { Pin, AlertTriangle, Info, Calendar as CalendarIcon, Bell } from 'lucide-react';

interface AnnouncementItemProps {
  announcement: {
    id: string;
    title: string;
    body: string;
    type: 'info' | 'warning' | 'urgent' | 'event';
    pinned: boolean;
    created_at: string;
  };
  isRead: boolean;
}

const TYPE_CONFIG = {
  info: {
    color: 'var(--color-info)',
    bg: 'bg-blue-500/10',
    icon: Info,
    label: 'Info',
  },
  warning: {
    color: 'var(--color-warning)',
    bg: 'bg-amber-500/10',
    icon: AlertTriangle,
    label: 'Warning',
  },
  urgent: {
    color: 'var(--ds-accent)',
    bg: 'bg-[var(--ds-accent)]/10',
    icon: AlertTriangle,
    label: 'Urgent',
  },
  event: {
    color: 'var(--color-success)',
    bg: 'bg-emerald-500/10',
    icon: CalendarIcon,
    label: 'Event',
  },
} as const;

export function AnnouncementItem({ announcement, isRead }: AnnouncementItemProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const markedRef = useRef(false);

  const config = TYPE_CONFIG[announcement.type];
  const TypeIcon = config.icon;

  useEffect(() => {
    if (isRead || markedRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !markedRef.current) {
          markedRef.current = true;
          markAnnouncementRead(announcement.id).catch(() => {
            // Silently ignore — non-critical
          });
          observer.disconnect();
        }
      },
      { threshold: 0.6 }
    );

    const el = cardRef.current;
    if (el) observer.observe(el);

    return () => observer.disconnect();
  }, [announcement.id, isRead]);

  return (
    <div
      ref={cardRef}
      className="card-surface card-interactive relative flex overflow-hidden reveal reveal-1"
    >
      {/* Left color stripe */}
      <div
        className="w-1 flex-shrink-0"
        style={{ backgroundColor: config.color }}
      />

      <div className="flex flex-1 flex-col gap-2.5 p-4">
        {/* Top row: icon + title + unread dot + pin */}
        <div className="flex items-start gap-3">
          {/* Type icon */}
          <div
            className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md ${config.bg}`}
          >
            <TypeIcon className="h-3.5 w-3.5" style={{ color: config.color }} />
          </div>

          {/* Title */}
          <div className="flex flex-1 items-start justify-between gap-2 min-w-0">
            <h3 className="text-sm font-semibold leading-snug text-shuttle-white">
              {announcement.title}
            </h3>

            <div className="flex flex-shrink-0 items-center gap-2 pt-0.5">
              {/* Unread dot */}
              {!isRead && (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--ds-accent)] opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--ds-accent)]" />
                </span>
              )}
              {/* Pin indicator */}
              {announcement.pinned && (
                <Pin className="h-3 w-3 text-gold" />
              )}
            </div>
          </div>
        </div>

        {/* Body */}
        <p className="pl-10 text-sm leading-relaxed text-[var(--text-muted)]">{announcement.body}</p>

        {/* Footer: type badge + time */}
        <div className="flex items-center justify-between pl-10">
          <span
            className="chip"
            style={{ color: config.color, borderColor: `${config.color}50`, background: `${config.color}18` }}
          >
            {config.label}
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            {formatRelativeTime(announcement.created_at)}
          </span>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useRef } from 'react';
import { markAnnouncementRead } from '@/lib/actions';
import { Pin } from 'lucide-react';

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

const TYPE_TAG: Record<AnnouncementItemProps['announcement']['type'], string> = {
  info: 'tag',
  event: 'tag tag-win',
  warning: 'tag tag-gold',
  urgent: 'tag tag-red',
};

function formatDateLong(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).toUpperCase();
}

export function AnnouncementItem({ announcement, isRead }: AnnouncementItemProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const markedRef = useRef(false);

  useEffect(() => {
    if (isRead || markedRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry?.isIntersecting && !markedRef.current) {
        markedRef.current = true;
        markAnnouncementRead(announcement.id).catch(() => {});
        observer.disconnect();
      }
    }, { threshold: 0.6 });
    const el = cardRef.current;
    if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [announcement.id, isRead]);

  return (
    <div ref={cardRef} className="ann">
      <div>
        <div className="ann-date">{formatDateLong(announcement.created_at)}</div>
        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <span className={TYPE_TAG[announcement.type]}>{announcement.type.toUpperCase()}</span>
          {announcement.pinned && <span className="tag tag-gold"><Pin size={10} /> PINNED</span>}
          {!isRead && <span className="tag tag-red">NEW</span>}
        </div>
      </div>
      <div>
        <h3>{announcement.title}</h3>
        <p>{announcement.body}</p>
      </div>
    </div>
  );
}

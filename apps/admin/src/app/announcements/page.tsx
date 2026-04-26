export const dynamic = 'force-dynamic';

import { createAdminClient } from '@/lib/supabase-server';
import { Card, Badge } from '@badminton/ui';
import { formatRelativeTime } from '@badminton/shared';
import { CreateAnnouncementForm, AnnouncementCardMenu } from './actions';
import { Megaphone, Pin } from 'lucide-react';

interface Announcement {
  id: string;
  title: string;
  body: string;
  type: 'info' | 'warning' | 'urgent' | 'event';
  author_id: string | null;
  pinned: boolean;
  send_push: boolean;
  target_audience: 'all' | 'competitive' | 'recreational' | 'eligible_only';
  expires_at: string | null;
  status: 'draft' | 'published';
  created_at: string;
  updated_at: string;
}

const TYPE_BADGE_VARIANT: Record<Announcement['type'], 'neutral' | 'warning' | 'danger' | 'success'> = {
  info: 'neutral',
  warning: 'warning',
  urgent: 'danger',
  event: 'success',
};

const STATUS_BADGE_VARIANT: Record<Announcement['status'], 'warning' | 'success'> = {
  draft: 'warning',
  published: 'success',
};

const AUDIENCE_LABEL: Record<Announcement['target_audience'], string> = {
  all: 'All Members',
  competitive: 'Competitive',
  recreational: 'Recreational',
  eligible_only: 'Eligible Only',
};

export default async function AnnouncementsPage() {
  const supabase = createAdminClient();

  const { data: announcements, error } = await supabase
    .from('announcements')
    .select('*')
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to fetch announcements:', error);
  }

  const items: Announcement[] = announcements ?? [];

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center w-10 h-10 rounded-lg"
            style={{ backgroundColor: 'var(--ds-accent)', color: '#fff' }}
          >
            <Megaphone size={20} />
          </div>
          <div>
            <h1
              className="text-xl font-bold tracking-widest uppercase"
              style={{ color: 'var(--text-primary)' }}
            >
              Announcements
            </h1>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Create and manage club announcements
            </p>
          </div>
        </div>

        <CreateAnnouncementForm />
      </div>

      {/* Announcement List */}
      {items.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center py-20 gap-3 rounded-xl border"
          style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
        >
          <Megaphone size={40} strokeWidth={1.5} />
          <p className="text-sm font-medium">No announcements yet</p>
          <p className="text-xs">Create your first announcement to get started.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((announcement) => (
            <Card key={announcement.id} className="p-4">
              <div className="flex items-start justify-between gap-4">
                {/* Left content */}
                <div className="flex flex-col gap-2 flex-1 min-w-0">
                  {/* Title row */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {announcement.pinned && (
                      <Pin
                        size={14}
                        style={{ color: 'var(--ds-accent)', flexShrink: 0 }}
                      />
                    )}
                    <span
                      className="font-semibold text-sm leading-snug"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {announcement.title}
                    </span>
                  </div>

                  {/* Body preview */}
                  <p
                    className="text-sm leading-relaxed line-clamp-2"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {announcement.body}
                  </p>

                  {/* Meta row */}
                  <div className="flex items-center gap-2 flex-wrap mt-1">
                    <Badge variant={TYPE_BADGE_VARIANT[announcement.type]}>
                      {announcement.type}
                    </Badge>
                    <Badge variant={STATUS_BADGE_VARIANT[announcement.status]}>
                      {announcement.status}
                    </Badge>
                    <span
                      className="text-xs px-2 py-0.5 rounded-full border"
                      style={{
                        color: 'var(--text-muted)',
                        borderColor: 'var(--border)',
                        backgroundColor: 'var(--bg-elevated)',
                      }}
                    >
                      {AUDIENCE_LABEL[announcement.target_audience]}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {formatRelativeTime(announcement.created_at)}
                    </span>
                  </div>
                </div>

                {/* Right: menu */}
                <div className="flex-shrink-0">
                  <AnnouncementCardMenu
                    announcement={{
                      id: announcement.id,
                      title: announcement.title,
                      body: announcement.body,
                      type: announcement.type,
                      target_audience: announcement.target_audience,
                      pinned: announcement.pinned,
                      send_push: announcement.send_push,
                      status: announcement.status,
                      expires_at: announcement.expires_at,
                    }}
                  />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

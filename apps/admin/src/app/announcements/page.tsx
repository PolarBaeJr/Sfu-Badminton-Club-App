export const dynamic = 'force-dynamic';

import { createAdminClient } from '@/lib/supabase-server';
import { PageHero } from '@badminton/ui';
import { CreateAnnouncementForm, AnnouncementCardMenu } from './actions';

interface Announcement {
  id: string;
  title: string;
  body: string;
  type: 'info' | 'warning' | 'urgent' | 'event';
  pinned: boolean;
  send_push: boolean;
  target_audience: 'all' | 'competitive' | 'recreational' | 'eligible_only';
  expires_at: string | null;
  status: 'draft' | 'published';
  created_at: string;
  updated_at: string;
}

export default async function AnnouncementsPage() {
  const supabase = createAdminClient();

  const { data: announcements } = await supabase
    .from('announcements')
    .select('*')
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });

  const items: Announcement[] = (announcements ?? []) as Announcement[];
  const drafts = items.filter((a) => a.status === 'draft').length;
  const published = items.filter((a) => a.status === 'published').length;

  return (
    <div>
      <PageHero
        eyebrow={`${published} published · ${drafts} draft${drafts === 1 ? '' : 's'}`}
        title="Announcements."
        subtitle="Club-wide communications. Pinned items appear on every player's dashboard."
        watermark="A"
      />

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          padding: '20px 48px 0',
        }}
      >
        <CreateAnnouncementForm />
      </div>

      {items.length === 0 ? (
        <div
          style={{
            padding: '64px 48px',
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          No announcements yet.
        </div>
      ) : (
        <div style={{ background: 'var(--surface1)' }}>
          {items.map((a) => {
            const tag: { label: string; color: string } =
              a.pinned
                ? { label: 'Pinned', color: 'var(--red)' }
                : a.status === 'draft'
                  ? { label: 'Draft', color: 'var(--amber)' }
                  : { label: 'Published', color: 'var(--muted)' };
            return (
              <div
                key={a.id}
                style={{
                  padding: '24px 48px',
                  borderBottom: '1px solid var(--hairline-soft)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 16,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                    <span
                      style={{
                        fontSize: 10,
                        letterSpacing: '0.2em',
                        textTransform: 'uppercase',
                        fontWeight: 600,
                        color: tag.color,
                      }}
                    >
                      {tag.label}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        letterSpacing: '0.2em',
                        textTransform: 'uppercase',
                        fontWeight: 600,
                        color: 'var(--faint)',
                      }}
                    >
                      {a.status === 'draft'
                        ? `Edited ${formatDate(a.updated_at)} · not published`
                        : `Posted ${formatDate(a.created_at)}`}
                    </span>
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontWeight: 700,
                      fontSize: 24,
                      color: 'var(--ink)',
                      letterSpacing: '-0.01em',
                    }}
                  >
                    {a.title}
                  </div>
                  <div
                    style={{
                      color: 'var(--text)',
                      marginTop: 8,
                      maxWidth: 640,
                      fontSize: 13,
                      lineHeight: 1.6,
                    }}
                  >
                    {a.body}
                  </div>
                </div>
                <div style={{ flexShrink: 0 }}>
                  <AnnouncementCardMenu
                    announcement={{
                      id: a.id,
                      title: a.title,
                      body: a.body,
                      type: a.type,
                      target_audience: a.target_audience,
                      pinned: a.pinned,
                      send_push: a.send_push,
                      status: a.status,
                      expires_at: a.expires_at,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

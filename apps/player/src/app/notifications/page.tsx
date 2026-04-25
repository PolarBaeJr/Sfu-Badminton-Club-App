import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { formatRelativeTime } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { NotificationActions, NotificationLink } from './actions';
import { Bell, BellOff } from 'lucide-react';

const NOTIF_TAG: Record<string, string> = {
  challenge_received: 'tag tag-red',
  challenge_accepted: 'tag tag-win',
  challenge_rejected: 'tag',
  challenge_cancelled: 'tag',
  result_pending: 'tag tag-gold',
  result_confirmed: 'tag tag-win',
  dispute_opened: 'tag tag-red',
  dispute_resolved: 'tag tag-win',
  rank_changed: 'tag tag-gold',
  session_reminder: 'tag',
  announcement: 'tag tag-gold',
  tournament_update: 'tag tag-gold',
  team_invite: 'tag tag-win',
  system: 'tag',
};

function tagFor(type: string) {
  if (NOTIF_TAG[type]) return NOTIF_TAG[type];
  const prefix = (type.split('_')[0] ?? '');
  const match = Object.keys(NOTIF_TAG).find((k) => k.startsWith(prefix));
  return match ? NOTIF_TAG[match] : 'tag';
}

function getNotificationHref(type: string, metadata: Record<string, unknown> | null): string | null {
  const challengeId = metadata?.challenge_id as string | undefined;
  if (challengeId && (type.startsWith('challenge') || type.startsWith('result') || type.startsWith('dispute'))) {
    return `/challenges/${challengeId}`;
  }
  if (type === 'rank_changed') return '/my-stats';
  if (type === 'session_reminder' && metadata?.session_id) return `/sessions/${metadata.session_id}`;
  if (type === 'tournament_update' && metadata?.tournament_id) return `/tournaments/${metadata.tournament_id}`;
  return null;
}

export default async function NotificationsPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const { data: notifications } = await supabase
    .from('notifications')
    .select('*')
    .eq('player_id', player.id)
    .order('created_at', { ascending: false })
    .limit(50);

  const all = notifications ?? [];
  const unread = all.filter((n) => !n.read_flag);
  const read = all.filter((n) => n.read_flag);

  function NotifRow({ n, dim }: { n: typeof all[number]; dim?: boolean }) {
    return (
      <NotificationLink notificationId={n.id} href={getNotificationHref(n.type, n.metadata)} isRead={n.read_flag}>
        <div
          className="row press"
          style={{
            padding: '14px 16px',
            border: '1px solid var(--line)',
            borderRadius: 12,
            background: 'var(--surface)',
            gap: 14,
            opacity: dim ? 0.65 : 1,
            borderLeft: !dim ? '3px solid var(--red)' : undefined,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
              <span className={tagFor(n.type)}>{n.type.replace(/_/g, ' ')}</span>
              {!dim && <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--red)' }} />}
              <span className="mono muted" style={{ fontSize: 11, marginLeft: 'auto' }}>
                {formatRelativeTime(n.created_at)}
              </span>
            </div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{n.title}</div>
            {n.body && <div style={{ color: 'var(--ink-2)', fontSize: 13, marginTop: 4 }}>{n.body}</div>}
          </div>
        </div>
      </NotificationLink>
    );
  }

  return (
    <div data-screen-label="Notifications">
      <div className="page-header">
        <div>
          <div className="page-eyebrow"><span className="bar" />INBOX · ALERTS</div>
          <h1 className="page-title">Notifications</h1>
          <div className="page-sub">
            Challenge updates, match confirmations, session reminders, and club announcements all land here.
          </div>
        </div>
        {unread.length > 0 && (
          <div className="row" style={{ gap: 10 }}>
            <span className="tag tag-red">{unread.length} UNREAD</span>
            <NotificationActions />
          </div>
        )}
      </div>

      {all.length === 0 ? (
        <div className="card-base">
          <div className="empty">
            <BellOff size={40} className="text-[var(--mute)]" style={{ display: 'block', margin: '0 auto 12px' }} />
            No notifications yet. When something happens, it&apos;ll land here.
          </div>
        </div>
      ) : (
        <div className="feed-col">
          {unread.length > 0 && (
            <div className="card-base">
              <div className="card-head">
                <h3 className="card-title">Unread</h3>
                <span className="tag tag-red">{unread.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {unread.map((n) => <NotifRow key={n.id} n={n} />)}
              </div>
            </div>
          )}
          {read.length > 0 && (
            <div className="card-base">
              <div className="card-head">
                <h3 className="card-title">Read</h3>
                <span className="tag">{read.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {read.map((n) => <NotifRow key={n.id} n={n} dim />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { CLUB_TIMEZONE, formatRelativeTime } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { BellOff } from 'lucide-react';
import { PageHeader } from '@badminton/ui';
import { MarkAllRead, NotificationRow } from './actions';
import {
  groupNotificationsByAge,
  notificationAction,
  notificationHeadline,
  notificationLabel,
  notificationTone,
  unreadEyebrow,
  type NotificationMetadata,
} from '@/lib/notification-rows';

type NotificationRecord = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_flag: boolean;
  metadata: NotificationMetadata;
  created_at: string;
};

function metadataOf(n: { metadata: NotificationMetadata }): Record<string, unknown> {
  return n.metadata && typeof n.metadata === 'object' ? n.metadata : {};
}

export default async function NotificationsPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  // Two queries, not one. The list is capped at 50 rows; the eyebrow's count is
  // an exact COUNT over the whole table, so it agrees with the bell in the top
  // bar (layout.tsx runs the same query) instead of quietly maxing out at 50.
  const [listResult, countResult] = await Promise.all([
    supabase
      .from('notifications')
      .select('id, type, title, body, read_flag, metadata, created_at')
      .eq('player_id', player.id)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('player_id', player.id)
      .eq('read_flag', false),
  ]);

  const all = (listResult.data ?? []) as NotificationRecord[];
  const unreadCount = countResult.count ?? 0;

  // Tournament result notifications are written with { match_id, event_id } and
  // no tournament_id (apps/admin/.../tournament-actions/results.ts), but the
  // event route needs both ids. One batched lookup back-fills them so those
  // rows get a live link instead of no link — the alternative is a whole class
  // of notification that can never be opened.
  const orphanEventIds = [
    ...new Set(
      all
        .map(metadataOf)
        .filter((m) => typeof m.event_id === 'string' && typeof m.tournament_id !== 'string')
        .map((m) => m.event_id as string),
    ),
  ];
  const tournamentByEvent = new Map<string, string>();
  if (orphanEventIds.length > 0) {
    const { data: events } = await supabase
      .from('tournament_events')
      .select('id, tournament_id')
      .in('id', orphanEventIds);
    for (const e of events ?? []) {
      if (e.tournament_id) tournamentByEvent.set(e.id as string, e.tournament_id as string);
    }
  }

  const rows = all.map((n) => {
    const base = metadataOf(n);
    const eventId = typeof base.event_id === 'string' ? base.event_id : null;
    const metadata =
      eventId && typeof base.tournament_id !== 'string' && tournamentByEvent.has(eventId)
        ? { ...base, tournament_id: tournamentByEvent.get(eventId) }
        : base;

    return {
      id: n.id,
      created_at: n.created_at,
      isRead: n.read_flag,
      headline: notificationHeadline(n),
      kind: notificationLabel(n.type),
      tone: notificationTone(n.type),
      when: formatRelativeTime(n.created_at),
      action: notificationAction(n.type, metadata),
    };
  });

  const sections = groupNotificationsByAge(rows, new Date(), CLUB_TIMEZONE);

  return (
    <div data-screen-label="Notifications">
      <PageHeader
        eyebrow={unreadEyebrow(unreadCount)}
        title="Notifications"
        className="notif-header"
        actions={<MarkAllRead disabled={unreadCount === 0} />}
      />

      {rows.length === 0 ? (
        <div className="card-base">
          <div className="empty">
            <BellOff size={40} className="text-[var(--mute)]" style={{ display: 'block', margin: '0 auto 12px' }} />
            No notifications yet. When something happens, it&apos;ll land here.
          </div>
        </div>
      ) : (
        <div className="notif-list">
          {sections.map((section) => (
            <div key={section.key}>
              <div className="notif-group">{section.label}</div>
              {section.items.map((row) => (
                <NotificationRow key={row.id} id={row.id} isRead={row.isRead} href={row.action?.href ?? null}>
                  <div className="notif-body">
                    <div className="notif-headline">{row.headline}</div>
                    <div className="notif-detail">
                      <span className="notif-kind" data-tone={row.tone}>
                        {row.kind}
                      </span>
                      {' · '}
                      {row.when}
                    </div>
                  </div>
                  {/* A span, not a <Button>: the whole row is already the click
                      target, and a button inside a button (or inside a link) is
                      invalid markup that React complains about on hydration.
                      Rows with nowhere to go get nothing here rather than a
                      control that does not work. */}
                  {row.action && <span className="notif-cta">{row.action.label}</span>}
                </NotificationRow>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

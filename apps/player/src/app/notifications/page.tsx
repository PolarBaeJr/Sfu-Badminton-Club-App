import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { Badge } from '@badminton/ui';
import { formatRelativeTime } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { NotificationActions, NotificationLink } from './actions';
import { NotificationsRealtime } from './realtime';
import Link from 'next/link';
import { Bell, BellOff, Swords, Megaphone, Calendar, Trophy, UserPlus, Info, CheckCheck, TrendingUp } from 'lucide-react';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/motion-wrapper';

const NOTIFICATION_ICON_MAP: Record<string, { icon: typeof Bell; color: string; bg: string }> = {
  // Challenge types
  challenge_received: { icon: Swords, color: 'text-[var(--ds-accent)]', bg: 'bg-[var(--ds-accent)]/10' },
  challenge_accepted: { icon: Swords, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  challenge_rejected: { icon: Swords, color: 'text-[var(--text-muted)]', bg: 'bg-[var(--on-surface-med)]' },
  challenge_cancelled: { icon: Swords, color: 'text-[var(--text-muted)]', bg: 'bg-[var(--on-surface-med)]' },
  // Result types
  result_pending: { icon: Trophy, color: 'text-gold', bg: 'bg-[var(--color-gold)]/10' },
  result_confirmed: { icon: Trophy, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  // Dispute types
  dispute_opened: { icon: Swords, color: 'text-orange-400', bg: 'bg-orange-500/10' },
  dispute_resolved: { icon: Swords, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  // Other types
  rank_changed: { icon: TrendingUp, color: 'text-gold', bg: 'bg-[var(--color-gold)]/10' },
  session_reminder: { icon: Calendar, color: 'text-blue-400', bg: 'bg-blue-500/10' },
  announcement: { icon: Megaphone, color: 'text-gold', bg: 'bg-[var(--color-gold)]/10' },
  tournament_update: { icon: Trophy, color: 'text-gold', bg: 'bg-[var(--color-gold)]/10' },
  team_invite: { icon: UserPlus, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  system: { icon: Info, color: 'text-[var(--text-muted)]', bg: 'bg-[var(--on-surface-med)]' },
};

function getNotificationMeta(type: string) {
  // Try exact match first, then prefix match
  if (NOTIFICATION_ICON_MAP[type]) return NOTIFICATION_ICON_MAP[type];
  const prefix = type.split('_')[0] ?? '';
  const prefixMatch = Object.entries(NOTIFICATION_ICON_MAP).find(([key]) => key.startsWith(prefix));
  return prefixMatch ? prefixMatch[1] : { icon: Bell, color: 'text-[var(--text-muted)]', bg: 'bg-[var(--on-surface-med)]' };
}

function getNotificationHref(
  type: string,
  metadata: Record<string, unknown> | null,
  actionUrl?: string | null
): string | null {
  // Phase 7: respect the new action_url column when set, else fall back to
  // the type+metadata heuristic so legacy rows keep routing correctly.
  if (actionUrl) return actionUrl;
  const challengeId = metadata?.challenge_id as string | undefined;
  if (challengeId && (type.startsWith('challenge') || type.startsWith('result') || type.startsWith('dispute'))) {
    return `/challenges/${challengeId}`;
  }
  if (type === 'rank_changed') return '/my-stats';
  if (type === 'session_reminder' && metadata?.session_id) return `/sessions/${metadata.session_id}`;
  if (type === 'session_starting' && metadata?.session_id) return `/sessions/${metadata.session_id}`;
  if (type === 'session_full' && metadata?.session_id) return `/sessions/${metadata.session_id}`;
  if (type.startsWith('tournament') && metadata?.tournament_id) return `/tournaments/${metadata.tournament_id}`;
  if (type === 'win_streak' || type === 'weekly_recap') return '/my-stats';
  return null;
}

// Filter tab definitions live close to the page they drive.
type FilterId = 'all' | 'unread' | 'challenges' | 'matches' | 'sessions' | 'other';

const FILTER_PREDICATES: Record<FilterId, (type: string, read: boolean) => boolean> = {
  all: () => true,
  unread: (_t, read) => !read,
  challenges: (t) => t.startsWith('challenge'),
  matches: (t) =>
    t.startsWith('result') ||
    t.startsWith('dispute') ||
    t === 'rank_changed' ||
    t === 'win_streak' ||
    t === 'walkover_reported' ||
    t === 'walkover_confirmed' ||
    t === 'opponent_withdrew',
  sessions: (t) => t.startsWith('session'),
  other: (t) =>
    t === 'admin_alert' ||
    t === 'general' ||
    t === 'weekly_recap' ||
    t === 'league_announcement' ||
    t === 'season_starting' ||
    t === 'season_ending' ||
    t.startsWith('tournament'),
};

const FILTER_LABELS: Array<{ id: FilterId; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'challenges', label: 'Challenges' },
  { id: 'matches', label: 'Matches' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'other', label: 'Other' },
];

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const { filter: filterParam } = await searchParams;
  const activeFilter: FilterId = (
    FILTER_LABELS.some((f) => f.id === filterParam) ? filterParam : 'all'
  ) as FilterId;

  const supabase = await createServerSupabaseClient();

  const { data: notifications } = await supabase
    .from('notifications')
    .select('*')
    .eq('player_id', player.id)
    .order('created_at', { ascending: false })
    .limit(50);

  const all = notifications ?? [];
  const totalUnread = all.filter((n) => !n.read_flag).length;
  const predicate = FILTER_PREDICATES[activeFilter];
  const filtered = all.filter((n) => predicate(n.type as string, !!n.read_flag));
  const unread = filtered.filter((n) => !n.read_flag);
  const read = filtered.filter((n) => n.read_flag);

  return (
    <div className="space-y-6">
      {/* Header */}
      <FadeIn>
        <div className="flex items-center justify-between reveal reveal-1">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[var(--ds-accent)]/10 flex items-center justify-center">
              <Bell className="w-5 h-5 text-court-red" />
            </div>
            <div>
              <p className="eyebrow">Inbox</p>
              <h1 className="display-lg text-shuttle-white">Notifications</h1>
            </div>
          </div>
          {totalUnread > 0 && (
            <div className="flex items-center gap-2">
              <span className="chip chip-red">{totalUnread}</span>
              <NotificationActions />
            </div>
          )}
        </div>
      </FadeIn>

      {/* Realtime: subscribes to new INSERTs for this player and triggers
          a router.refresh() so the inbox updates without a manual reload. */}
      <NotificationsRealtime playerId={player.id} />

      {/* Filter tabs — URL-driven so they're shareable + survive refresh. */}
      <FadeIn delay={0.03}>
        <div
          className="reveal reveal-1"
          style={{
            display: 'flex',
            gap: 6,
            overflowX: 'auto',
            paddingBottom: 2,
          }}
        >
          {FILTER_LABELS.map((f) => {
            const active = activeFilter === f.id;
            const showBadge = f.id === 'unread' && totalUnread > 0;
            return (
              <Link
                key={f.id}
                href={f.id === 'all' ? '/notifications' : `/notifications?filter=${f.id}`}
                aria-pressed={active}
                style={{
                  padding: '8px 14px',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  textDecoration: 'none',
                  background: active ? 'var(--red)' : 'var(--surface1)',
                  color: active ? '#F2F2F2' : 'var(--text)',
                  border: active ? 'none' : '1px solid var(--hairline)',
                  whiteSpace: 'nowrap',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {f.label}
                {showBadge && (
                  <span style={{ fontSize: 10, opacity: 0.85 }}>· {totalUnread}</span>
                )}
              </Link>
            );
          })}
        </div>
      </FadeIn>

      {/* Unread Section */}
      {unread.length > 0 && (
        <FadeIn delay={0.05}>
          <div className="card-elevated p-4" style={{ borderColor: 'color-mix(in srgb, var(--color-danger) 12%, transparent)' }}>
            <div className="flex items-center gap-2 mb-3">
              <Bell className="w-4 h-4 text-court-red" />
              <h2 className="eyebrow" style={{ color: 'var(--text-primary)' }}>Unread</h2>
              <span className="ml-auto chip chip-red">{unread.length}</span>
            </div>
            <StaggerContainer className="space-y-2">
              {unread.map((n) => {
                const meta = getNotificationMeta(n.type);
                const Icon = meta.icon;
                return (
                  <StaggerItem key={n.id}>
                    <NotificationLink notificationId={n.id} href={getNotificationHref(n.type, n.metadata, (n as { action_url?: string | null }).action_url)} isRead={n.read_flag}>
                      <div className="card-surface card-interactive flex items-start gap-3 p-4 border-l-2 border-l-[var(--ds-accent)]">
                        <div className={`w-9 h-9 ${meta.bg} flex items-center justify-center shrink-0 mt-0.5`}>
                          <Icon className={`w-4 h-4 ${meta.color}`} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <div className="w-2 h-2 rounded-full bg-[var(--ds-accent)] shrink-0" />
                                <p className="text-sm font-semibold text-shuttle-white truncate">{n.title}</p>
                              </div>
                              {n.body && (
                                <p className="text-sm text-[var(--text-secondary)] mt-1 line-clamp-2">{n.body}</p>
)}
                              <p className="text-xs text-[var(--text-muted)] mt-1.5">{formatRelativeTime(n.created_at)}</p>
                            </div>
                            <span className={`chip shrink-0 ${meta.bg} ${meta.color}`}>
                              {n.type.replace(/_/g, ' ')}
                            </span>
                          </div>
                        </div>
                      </div>
                    </NotificationLink>
                  </StaggerItem>
                );
              })}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}

      {/* Read Section */}
      {read.length > 0 && (
        <FadeIn delay={0.1}>
          <div className="card-elevated p-4">
            <div className="flex items-center gap-2 mb-3">
              <CheckCheck className="w-4 h-4 text-[var(--text-muted)]" />
              <h2 className="eyebrow" style={{ color: 'var(--text-primary)' }}>Read</h2>
            </div>
            <StaggerContainer className="space-y-2">
              {read.map((n) => {
                const meta = getNotificationMeta(n.type);
                const Icon = meta.icon;
                return (
                  <StaggerItem key={n.id}>
                    <NotificationLink notificationId={n.id} href={getNotificationHref(n.type, n.metadata, (n as { action_url?: string | null }).action_url)} isRead={n.read_flag}>
                      <div className="card-surface flex items-start gap-3 p-4 opacity-60 hover:opacity-80 transition-all duration-200">
                        <div className={`w-9 h-9 bg-[var(--on-surface-soft)] flex items-center justify-center shrink-0 mt-0.5`}>
                          <Icon className="w-4 h-4 text-[var(--text-dim)]" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-[var(--text-secondary)] truncate">{n.title}</p>
                              {n.body && (
                                <p className="text-sm text-[var(--text-muted)] mt-1 line-clamp-2">{n.body}</p>
                              )}
                              <p className="text-xs text-[var(--text-dim)] mt-1.5">{formatRelativeTime(n.created_at)}</p>
                            </div>
                            <span className="chip shrink-0 opacity-60">
                              {n.type.replace(/_/g, ' ')}
                            </span>
                          </div>
                        </div>
                      </div>
                    </NotificationLink>
                  </StaggerItem>
                );
              })}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}

      {/* Empty State — distinguishes "inbox totally empty" from "filter
          turned up nothing" so users aren't confused when a non-default
          filter looks empty. */}
      {filtered.length === 0 && (
        <FadeIn delay={0.05}>
          <div className="card-elevated p-12 text-center">
            <BellOff className="w-12 h-12 text-[var(--text-dim)] mx-auto mb-3" />
            <p className="text-[var(--text-muted)] mb-1 font-medium">
              {all.length === 0 ? 'No notifications yet' : 'Nothing in this filter'}
            </p>
            <p className="text-[var(--text-dim)] text-sm">
              {all.length === 0
                ? 'When you receive challenges, session updates, or announcements they will appear here.'
                : 'Switch back to All to see everything.'}
            </p>
          </div>
        </FadeIn>
      )}
    </div>
  );
}

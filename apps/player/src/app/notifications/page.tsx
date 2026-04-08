import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { Badge } from '@badminton/ui';
import { formatRelativeTime } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { NotificationActions, NotificationLink } from './actions';
import { Bell, BellOff, Swords, Megaphone, Calendar, Trophy, UserPlus, Info, CheckCheck, TrendingUp } from 'lucide-react';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/motion-wrapper';

const NOTIFICATION_ICON_MAP: Record<string, { icon: typeof Bell; color: string; bg: string }> = {
  // Challenge types
  challenge_received: { icon: Swords, color: 'text-[var(--color-accent)]', bg: 'bg-[var(--color-accent)]/10' },
  challenge_accepted: { icon: Swords, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  challenge_rejected: { icon: Swords, color: 'text-[var(--text-muted)]', bg: 'bg-white/[0.06]' },
  challenge_cancelled: { icon: Swords, color: 'text-[var(--text-muted)]', bg: 'bg-white/[0.06]' },
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
  system: { icon: Info, color: 'text-[var(--text-muted)]', bg: 'bg-white/[0.06]' },
};

function getNotificationMeta(type: string) {
  // Try exact match first, then prefix match
  if (NOTIFICATION_ICON_MAP[type]) return NOTIFICATION_ICON_MAP[type];
  const prefix = type.split('_')[0] ?? '';
  const prefixMatch = Object.entries(NOTIFICATION_ICON_MAP).find(([key]) => key.startsWith(prefix));
  return prefixMatch ? prefixMatch[1] : { icon: Bell, color: 'text-[var(--text-muted)]', bg: 'bg-white/[0.06]' };
}

function getNotificationHref(type: string, metadata: Record<string, unknown> | null): string | null {
  const challengeId = metadata?.challenge_id as string | undefined;
  const matchId = metadata?.match_id as string | undefined;

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

  const unread = notifications?.filter((n) => !n.read_flag) || [];
  const read = notifications?.filter((n) => n.read_flag) || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <FadeIn>
        <div className="flex items-center justify-between reveal reveal-1">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[var(--color-accent)]/10 flex items-center justify-center">
              <Bell className="w-5 h-5 text-court-red" />
            </div>
            <div>
              <p className="eyebrow">Inbox</p>
              <h1 className="display-lg text-shuttle-white">Notifications</h1>
            </div>
          </div>
          {unread.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="chip chip-red">{unread.length}</span>
              <NotificationActions />
            </div>
          )}
        </div>
      </FadeIn>

      {/* Unread Section */}
      {unread.length > 0 && (
        <FadeIn delay={0.05}>
          <div className="card-elevated p-4" style={{ borderColor: 'rgba(239,68,68,0.12)' }}>
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
                    <NotificationLink notificationId={n.id} href={getNotificationHref(n.type, n.metadata)} isRead={n.read_flag}>
                      <div className="card-surface card-interactive flex items-start gap-3 p-4 border-l-2 border-l-[#EF4444]">
                        <div className={`w-9 h-9 rounded-lg ${meta.bg} flex items-center justify-center shrink-0 mt-0.5`}>
                          <Icon className={`w-4 h-4 ${meta.color}`} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <div className="w-2 h-2 rounded-full bg-[var(--color-accent)] shrink-0" />
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
                    <NotificationLink notificationId={n.id} href={getNotificationHref(n.type, n.metadata)} isRead={n.read_flag}>
                      <div className="card-surface flex items-start gap-3 p-4 rounded-xl opacity-60 hover:opacity-80 transition-all duration-200">
                        <div className={`w-9 h-9 rounded-lg bg-white/[0.04] flex items-center justify-center shrink-0 mt-0.5`}>
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

      {/* Empty State */}
      {(!notifications || notifications.length === 0) && (
        <FadeIn delay={0.05}>
          <div className="card-elevated p-12 text-center">
            <BellOff className="w-12 h-12 text-[#1E293B] mx-auto mb-3" />
            <p className="text-[var(--text-muted)] mb-1 font-medium">No notifications yet</p>
            <p className="text-[var(--text-dim)] text-sm">When you receive challenges, session updates, or announcements they will appear here.</p>
          </div>
        </FadeIn>
      )}
    </div>
  );
}

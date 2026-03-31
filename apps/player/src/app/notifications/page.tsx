import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { Badge } from '@badminton/ui';
import { formatRelativeTime } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { NotificationActions } from './actions';
import { Bell, BellOff, Swords, Megaphone, Calendar, Trophy, UserPlus, Info, CheckCheck } from 'lucide-react';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/motion-wrapper';

const NOTIFICATION_ICON_MAP: Record<string, { icon: typeof Bell; color: string; bg: string }> = {
  challenge: { icon: Swords, color: 'text-[#EF4444]', bg: 'bg-[#EF4444]/10' },
  announcement: { icon: Megaphone, color: 'text-[#FFD700]', bg: 'bg-[#FFD700]/10' },
  session: { icon: Calendar, color: 'text-blue-400', bg: 'bg-blue-500/10' },
  tournament: { icon: Trophy, color: 'text-[#FFD700]', bg: 'bg-[#FFD700]/10' },
  team: { icon: UserPlus, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  system: { icon: Info, color: 'text-[#64748B]', bg: 'bg-white/[0.06]' },
};

function getNotificationMeta(type: string) {
  return NOTIFICATION_ICON_MAP[type] || { icon: Bell, color: 'text-[#64748B]', bg: 'bg-white/[0.06]' };
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
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#EF4444]/10 flex items-center justify-center">
              <Bell className="w-5 h-5 text-[#EF4444]" />
            </div>
            <div>
              <h1 className="text-3xl font-black font-display text-shuttle-white tracking-wider uppercase">
                Notifications
              </h1>
              {unread.length > 0 && (
                <p className="text-xs text-[#64748B] mt-0.5">
                  {unread.length} unread notification{unread.length !== 1 ? 's' : ''}
                </p>
              )}
            </div>
          </div>
          {unread.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="bg-[#EF4444]/10 text-[#EF4444] text-xs font-bold px-2.5 py-1 rounded-full">
                {unread.length}
              </span>
              <NotificationActions />
            </div>
          )}
        </div>
      </FadeIn>

      {/* Unread Section */}
      {unread.length > 0 && (
        <FadeIn delay={0.05}>
          <div className="bg-[#161B2E] border border-[#EF4444]/10 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Bell className="w-4 h-4 text-[#EF4444]" />
              <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">
                Unread
              </h2>
              <span className="ml-auto bg-[#EF4444]/10 text-[#EF4444] text-xs font-bold px-2 py-0.5 rounded-full">
                {unread.length}
              </span>
            </div>
            <StaggerContainer className="space-y-2">
              {unread.map((n) => {
                const meta = getNotificationMeta(n.type);
                const Icon = meta.icon;
                return (
                  <StaggerItem key={n.id}>
                    <div className="flex items-start gap-3 p-4 bg-white/[0.03] rounded-xl border border-white/[0.04] border-l-2 border-l-[#EF4444] hover:bg-white/[0.05] transition-all duration-200">
                      <div className={`w-9 h-9 rounded-lg ${meta.bg} flex items-center justify-center shrink-0 mt-0.5`}>
                        <Icon className={`w-4 h-4 ${meta.color}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <div className="w-2 h-2 rounded-full bg-[#EF4444] shrink-0" />
                              <p className="text-sm font-semibold text-shuttle-white truncate">{n.title}</p>
                            </div>
                            {n.body && (
                              <p className="text-sm text-[#94A3B8] mt-1 line-clamp-2">{n.body}</p>
                            )}
                            <p className="text-xs text-[#64748B] mt-1.5">{formatRelativeTime(n.created_at)}</p>
                          </div>
                          <span className={`text-[10px] px-2 py-1 rounded-full font-semibold shrink-0 ${meta.bg} ${meta.color}`}>
                            {n.type}
                          </span>
                        </div>
                      </div>
                    </div>
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
          <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <CheckCheck className="w-4 h-4 text-[#64748B]" />
              <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">
                Read
              </h2>
            </div>
            <StaggerContainer className="space-y-2">
              {read.map((n) => {
                const meta = getNotificationMeta(n.type);
                const Icon = meta.icon;
                return (
                  <StaggerItem key={n.id}>
                    <div className="flex items-start gap-3 p-4 bg-white/[0.02] rounded-xl border border-white/[0.03] opacity-60 hover:opacity-80 transition-all duration-200">
                      <div className={`w-9 h-9 rounded-lg bg-white/[0.04] flex items-center justify-center shrink-0 mt-0.5`}>
                        <Icon className="w-4 h-4 text-[#475569]" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-[#94A3B8] truncate">{n.title}</p>
                            {n.body && (
                              <p className="text-sm text-[#64748B] mt-1 line-clamp-2">{n.body}</p>
                            )}
                            <p className="text-xs text-[#475569] mt-1.5">{formatRelativeTime(n.created_at)}</p>
                          </div>
                          <span className="text-[10px] px-2 py-1 rounded-full font-semibold shrink-0 bg-white/[0.04] text-[#475569]">
                            {n.type}
                          </span>
                        </div>
                      </div>
                    </div>
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
          <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-12 text-center">
            <BellOff className="w-12 h-12 text-[#1E293B] mx-auto mb-3" />
            <p className="text-[#64748B] mb-1 font-medium">No notifications yet</p>
            <p className="text-[#475569] text-sm">When you receive challenges, session updates, or announcements they will appear here.</p>
          </div>
        </FadeIn>
      )}
    </div>
  );
}

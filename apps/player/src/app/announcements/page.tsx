import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { Badge } from '@badminton/ui';
import { formatRelativeTime } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { MarkAllReadButton } from './mark-read';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/motion-wrapper';
import {
  Megaphone,
  Pin,
  AlertTriangle,
  Info,
  Calendar,
  Clock,
  User,
  BellOff,
  Flame,
} from 'lucide-react';

const typeConfig: Record<
  string,
  { border: string; bg: string; text: string; icon: typeof Info; label: string }
> = {
  info: {
    border: 'border-l-blue-500',
    bg: 'bg-blue-500/10',
    text: 'text-blue-400',
    icon: Info,
    label: 'Info',
  },
  warning: {
    border: 'border-l-[#F59E0B]',
    bg: 'bg-yellow-500/10',
    text: 'text-yellow-400',
    icon: AlertTriangle,
    label: 'Warning',
  },
  urgent: {
    border: 'border-l-[#EF4444]',
    bg: 'bg-red-500/10',
    text: 'text-red-400',
    icon: Flame,
    label: 'Urgent',
  },
  event: {
    border: 'border-l-emerald-500',
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-400',
    icon: Calendar,
    label: 'Event',
  },
};

export default async function AnnouncementsPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const { data: announcements } = await supabase
    .from('announcements')
    .select('*, author:players!announcements_author_id_fkey(full_name)')
    .eq('status', 'published')
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });

  const { data: reads } = await supabase
    .from('announcement_reads')
    .select('announcement_id')
    .eq('player_id', player.id);

  const readIds = new Set(reads?.map((r) => r.announcement_id) ?? []);

  const unreadCount =
    announcements?.filter((a) => !readIds.has(a.id)).length ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <FadeIn>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#EF4444]/10">
              <Megaphone className="h-5 w-5 text-[#EF4444]" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">
                Announcements
              </h1>
              {unreadCount > 0 && (
                <p className="text-sm text-gray-400">
                  {unreadCount} unread{' '}
                  {unreadCount === 1 ? 'announcement' : 'announcements'}
                </p>
              )}
            </div>
          </div>
          <MarkAllReadButton playerId={player.id} />
        </div>
      </FadeIn>

      {/* Announcement List */}
      {announcements && announcements.length > 0 ? (
        <StaggerContainer className="space-y-3">
          {announcements.map((a) => {
            const isRead = readIds.has(a.id);
            const author = a.author as Record<string, unknown> | null;
            const config = (typeConfig[a.type] ?? typeConfig.info)!;
            const TypeIcon = config.icon;

            return (
              <StaggerItem key={a.id}>
                <div
                  className={`
                    relative overflow-hidden rounded-xl border-l-4
                    ${config.border}
                    ${a.pinned ? 'border border-l-4 border-[#FFD700]/30 bg-[#161B2E]' : 'border border-l-4 border-white/[0.06] bg-[#161B2E]'}
                    ${!isRead ? 'ring-1 ring-[#EF4444]/25' : ''}
                    transition-all duration-200 hover:border-white/[0.12]
                  `}
                >
                  {/* Pinned gold accent bar */}
                  {a.pinned && (
                    <div className="absolute top-0 right-0 h-full w-1 bg-gradient-to-b from-[#FFD700] to-[#FFD700]/20" />
                  )}

                  <div className="p-4 sm:p-5">
                    <div className="flex items-start gap-3">
                      {/* Unread indicator */}
                      {!isRead && (
                        <div className="mt-2 h-2.5 w-2.5 flex-shrink-0 rounded-full bg-[#EF4444] shadow-[0_0_6px_rgba(239,68,68,0.4)]" />
                      )}

                      {/* Type icon */}
                      <div
                        className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${config.bg}`}
                      >
                        <TypeIcon className={`h-4 w-4 ${config.text}`} />
                      </div>

                      {/* Content */}
                      <div className="min-w-0 flex-1">
                        {/* Badges row */}
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <Badge
                            variant={
                              a.type === 'urgent'
                                ? 'danger'
                                : a.type === 'warning'
                                  ? 'warning'
                                  : a.type === 'event'
                                    ? 'info'
                                    : 'default'
                            }
                          >
                            {config.label}
                          </Badge>
                          {a.pinned && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[#FFD700]/10 px-2 py-0.5 text-xs font-medium text-[#FFD700]">
                              <Pin className="h-3 w-3" />
                              Pinned
                            </span>
                          )}
                          {!isRead && (
                            <span className="text-xs font-medium text-[#EF4444]">
                              New
                            </span>
                          )}
                        </div>

                        {/* Title */}
                        <h3
                          className={`text-base font-semibold leading-snug ${
                            isRead ? 'text-gray-300' : 'text-white'
                          }`}
                        >
                          {a.title}
                        </h3>

                        {/* Body */}
                        {a.body && (
                          <p
                            className={`mt-1.5 text-sm leading-relaxed whitespace-pre-wrap ${
                              isRead ? 'text-gray-500' : 'text-gray-400'
                            }`}
                          >
                            {a.body}
                          </p>
                        )}

                        {/* Meta */}
                        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                          <span className="inline-flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {(author?.full_name as string) || 'Club Admin'}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatRelativeTime(a.created_at)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </StaggerItem>
            );
          })}
        </StaggerContainer>
      ) : (
        /* Empty State */
        <FadeIn delay={0.1}>
          <div className="rounded-xl border border-white/[0.06] bg-[#161B2E] p-12 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white/[0.04]">
              <BellOff className="h-7 w-7 text-gray-600" />
            </div>
            <h3 className="text-lg font-semibold text-gray-300">
              No announcements yet
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              When the club posts updates, they will appear here.
            </p>
          </div>
        </FadeIn>
      )}
    </div>
  );
}

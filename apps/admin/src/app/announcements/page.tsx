import { createAdminClient } from '@/lib/supabase-server';
import { Card, Badge } from '@badminton/ui';
import { formatRelativeTime } from '@badminton/shared';
import { AnnouncementComposer } from './composer';
import {
  Megaphone,
  Pin,
  AlertTriangle,
  Info,
  Flame,
  Calendar,
  Clock,
  User,
  MessageSquare,
} from 'lucide-react';

const typeConfig: Record<string, { icon: typeof Info; color: string; borderColor: string; bgColor: string }> = {
  info: {
    icon: Info,
    color: 'text-blue-400',
    borderColor: 'border-l-blue-500',
    bgColor: 'bg-blue-500/10',
  },
  warning: {
    icon: AlertTriangle,
    color: 'text-amber-400',
    borderColor: 'border-l-[#F59E0B]',
    bgColor: 'bg-amber-500/10',
  },
  urgent: {
    icon: Flame,
    color: 'text-red-400',
    borderColor: 'border-l-[#EF4444]',
    bgColor: 'bg-red-500/10',
  },
  event: {
    icon: Calendar,
    color: 'text-purple-400',
    borderColor: 'border-l-purple-500',
    bgColor: 'bg-purple-500/10',
  },
};

export default async function AnnouncementsPage() {
  const supabase = createAdminClient();

  const { data: announcements } = await supabase
    .from('announcements')
    .select('*, author:players!announcements_author_id_fkey(full_name)')
    .order('created_at', { ascending: false });

  const { count: totalPlayers } = await supabase
    .from('players')
    .select('*', { count: 'exact', head: true })
    .neq('status', 'pending_approval');

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-accent)]/10 ring-1 ring-[var(--color-accent)]/20">
          <Megaphone className="h-6 w-6 text-[var(--color-accent)]" />
        </div>
        <div>
          <h1 className="text-3xl font-bold font-display text-white tracking-tight">
            ANNOUNCEMENTS
          </h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Compose and manage announcements for club members
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-7 gap-8">
        {/* Left -- List */}
        <div className="lg:col-span-4 space-y-5">
          {/* Filter tabs */}
          <div className="flex gap-1.5 rounded-xl bg-white/[0.03] p-1.5 ring-1 ring-white/5">
            {['All', 'Published', 'Drafts', 'Expired'].map((tab, i) => (
              <button
                key={tab}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                  i === 0
                    ? 'bg-[var(--color-accent)] text-white shadow-lg shadow-[var(--color-accent)]/20'
                    : 'text-gray-400 hover:text-white hover:bg-white/[0.06]'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* Announcement cards */}
          {announcements && announcements.length > 0 ? (
            <div className="space-y-3">
              {announcements.map((a) => {
                const config = (typeConfig[a.type] ?? typeConfig.info)!;
                const TypeIcon = config.icon;
                const author = a.author as Record<string, unknown> | null;

                return (
                  <Card
                    key={a.id}
                    className={`border-l-4 ${config.borderColor} transition-all hover:ring-1 hover:ring-white/10`}
                  >
                    <div className="flex items-start gap-4">
                      {/* Type icon indicator */}
                      <div
                        className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${config.bgColor}`}
                      >
                        <TypeIcon className={`h-4.5 w-4.5 ${config.color}`} />
                      </div>

                      <div className="flex-1 min-w-0">
                        {/* Badges row */}
                        <div className="flex flex-wrap items-center gap-2 mb-1.5">
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
                            {a.type}
                          </Badge>
                          {a.pinned && (
                            <Badge variant="neutral">
                              <span className="flex items-center gap-1">
                                <Pin className="h-3 w-3" />
                                Pinned
                              </span>
                            </Badge>
                          )}
                          <Badge
                            variant={
                              a.status === 'published' ? 'success' : 'neutral'
                            }
                          >
                            {a.status}
                          </Badge>
                        </div>

                        {/* Title */}
                        <h3 className="text-white font-semibold leading-snug">
                          {a.title}
                        </h3>

                        {/* Body preview */}
                        <p className="text-sm text-gray-400 mt-1 line-clamp-2 leading-relaxed">
                          {a.body}
                        </p>

                        {/* Meta row */}
                        <div className="flex flex-wrap items-center gap-4 mt-3 text-xs text-gray-500">
                          <span className="flex items-center gap-1.5">
                            <User className="h-3.5 w-3.5" />
                            {(author?.full_name as string) || 'System'}
                          </span>
                          <span className="flex items-center gap-1.5">
                            <Clock className="h-3.5 w-3.5" />
                            {formatRelativeTime(a.created_at)}
                          </span>
                          {a.target_audience && (
                            <span className="flex items-center gap-1.5">
                              <MessageSquare className="h-3.5 w-3.5" />
                              {a.target_audience}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          ) : (
            <Card>
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.04] ring-1 ring-white/10 mb-4">
                  <Megaphone className="h-7 w-7 text-gray-500" />
                </div>
                <p className="text-gray-400 font-medium">
                  No announcements yet
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  Use the composer to create your first announcement
                </p>
              </div>
            </Card>
          )}
        </div>

        {/* Right -- Composer */}
        <div className="lg:col-span-3">
          <AnnouncementComposer totalPlayers={totalPlayers ?? 0} />
        </div>
      </div>
    </div>
  );
}

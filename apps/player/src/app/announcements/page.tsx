import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { formatRelativeTime } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { Megaphone, Pin } from 'lucide-react';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/motion-wrapper';
import { AnnouncementItem } from './announcement-item';

interface Announcement {
  id: string;
  title: string;
  body: string;
  type: 'info' | 'warning' | 'urgent' | 'event';
  pinned: boolean;
  status: 'draft' | 'published';
  target_audience: 'all' | 'competitive' | 'recreational' | 'eligible_only';
  expires_at: string | null;
  created_at: string;
}

interface AnnouncementRead {
  id: string;
  announcement_id: string;
  player_id: string;
  read_at: string;
}

export default async function AnnouncementsPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const { data: announcements } = await supabase
    .from('announcements')
    .select('*')
    .eq('status', 'published')
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .returns<Announcement[]>();

  const { data: reads } = await supabase
    .from('announcement_reads')
    .select('*')
    .eq('player_id', player.id)
    .returns<AnnouncementRead[]>();

  const readSet = new Set((reads ?? []).map((r) => r.announcement_id));

  const pinnedAnnouncements = (announcements ?? []).filter((a) => a.pinned);
  const regularAnnouncements = (announcements ?? []).filter((a) => !a.pinned);

  return (
    <div className="min-h-screen">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <FadeIn>
          <div className="mb-8 reveal reveal-1">
            <div className="flex items-center gap-3 mb-1">
              <div className="w-9 h-9 rounded-lg bg-[#EF4444]/10 flex items-center justify-center">
                <Megaphone className="w-5 h-5 text-court-red" />
              </div>
              <div>
                <p className="eyebrow">Club</p>
                <h1 className="display-lg text-shuttle-white">News</h1>
              </div>
            </div>
          </div>
        </FadeIn>

        {(announcements ?? []).length === 0 ? (
          /* Empty state */
          <FadeIn>
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <div className="w-16 h-16 rounded-2xl bg-[#161B2E] border border-white/[0.06] flex items-center justify-center">
                <Megaphone className="w-8 h-8 text-[#64748B]" />
              </div>
              <p className="text-[#64748B] text-sm">No announcements yet. Check back soon.</p>
            </div>
          </FadeIn>
        ) : (
          <div className="space-y-8">
            {/* Pinned announcements */}
            {pinnedAnnouncements.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Pin className="w-3.5 h-3.5 text-gold" />
                  <span className="eyebrow text-gold">Pinned</span>
                </div>
                <StaggerContainer className="space-y-3">
                  {pinnedAnnouncements.map((announcement) => (
                    <StaggerItem key={announcement.id}>
                      <AnnouncementItem
                        announcement={announcement}
                        isRead={readSet.has(announcement.id)}
                      />
                    </StaggerItem>
                  ))}
                </StaggerContainer>
              </section>
            )}

            {/* Regular announcements */}
            {regularAnnouncements.length > 0 && (
              <section>
                {pinnedAnnouncements.length > 0 && (
                  <div className="flex items-center gap-2 mb-3">
                    <span className="eyebrow">All Updates</span>
                  </div>
                )}
                <StaggerContainer className="space-y-3">
                  {regularAnnouncements.map((announcement) => (
                    <StaggerItem key={announcement.id}>
                      <AnnouncementItem
                        announcement={announcement}
                        isRead={readSet.has(announcement.id)}
                      />
                    </StaggerItem>
                  ))}
                </StaggerContainer>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

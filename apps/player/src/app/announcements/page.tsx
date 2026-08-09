import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { Megaphone } from 'lucide-react';
import { PageHeader } from '@badminton/ui';
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

  // This term's announcements, plus the evergreen ones.
  //
  // Without the season filter the feed was cumulative forever: after a rollover
  // last term's "courts closed for reading week" still sat pinned above this
  // term's, and the only way to retire it was to delete it — which throws away
  // the record of having said it. 00085 gives every row exactly one of two
  // shapes, so this filter has no ambiguous NULL to worry about.
  //
  // No active season means no season filter, deliberately. Between terms, a
  // feed that has gone blank reads to a member as a broken app; showing
  // everything is the gentler failure, and it is the same rule the schedule and
  // the tournament list already follow.
  const { data: activeSeason } = await supabase
    .from('seasons').select('id').eq('active_flag', true).maybeSingle();

  const nowIso = new Date().toISOString();
  let query = supabase
    .from('announcements')
    .select('*')
    .eq('status', 'published')
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`);

  if (activeSeason?.id) {
    query = query.or(`all_seasons.eq.true,season_id.eq.${activeSeason.id}`);
  }

  const { data: announcements } = await query
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .returns<Announcement[]>();

  const { data: reads } = await supabase
    .from('announcement_reads')
    .select('*')
    .eq('player_id', player.id)
    .returns<AnnouncementRead[]>();

  const readSet = new Set((reads ?? []).map((r) => r.announcement_id));
  // RLS only checks status='published'; expiry + audience must be filtered here.
  // Expiry is applied in the query above; audience is matched to the viewer's
  // division / eligibility.
  const all = (announcements ?? []).filter(
    (a) =>
      a.target_audience === 'all' ||
      a.target_audience === player.status ||
      (a.target_audience === 'eligible_only' && player.eligibility_flag)
  );
  const pinned = all.filter((a) => a.pinned);
  const regular = all.filter((a) => !a.pinned);

  return (
    <div data-screen-label="News">
      <PageHeader
        title="News"
        sub="Updates from the executive team. Sessions, tournaments, policy changes — keep an eye on pinned posts at the top."
      />

      {all.length === 0 ? (
        <div className="card-base">
          <div className="empty">
            <Megaphone size={40} className="text-[var(--mute)]" style={{ display: 'block', margin: '0 auto 12px' }} />
            No announcements yet. Check back soon.
          </div>
        </div>
      ) : (
        <div className="grid grid-12">
          <div style={{ gridColumn: 'span 8' }} className="feed-col">
            {pinned.length > 0 && (
              <div className="card-base">
                <div className="card-head">
                  <h3 className="card-title">Pinned</h3>
                  <span className="tag tag-gold">{pinned.length}</span>
                </div>
                {pinned.map((a) => (
                  <AnnouncementItem key={a.id} announcement={a} isRead={readSet.has(a.id)} />
                ))}
              </div>
            )}
            <div className="card-base">
              <div className="card-head">
                <h3 className="card-title">All updates</h3>
                {regular.length > 0 && <span className="tag">{regular.length}</span>}
              </div>
              {regular.length === 0 ? (
                <div className="empty" style={{ padding: 24 }}>Nothing else fresh today.</div>
              ) : (
                regular.map((a) => (
                  <AnnouncementItem key={a.id} announcement={a} isRead={readSet.has(a.id)} />
                ))
              )}
            </div>
          </div>
          <div style={{ gridColumn: 'span 4' }} className="feed-col">
            <div className="card-base">
              <div className="card-head">
                <h3 className="card-title">About these</h3>
              </div>
              <div className="page-sub" style={{ marginTop: 0, fontSize: 13 }}>
                Announcements expire after their expiry date and are filtered to your division. Newest first; pinned posts stay on top until removed.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

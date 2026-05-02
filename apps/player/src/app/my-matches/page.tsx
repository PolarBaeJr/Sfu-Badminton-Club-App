import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { DPageHead, DStat } from '@/components/desktop/page-shell';
import { MyMatchesFilter } from './my-matches-filter';

type MatchRow = {
  id: string;
  win_flag: boolean | null;
  rating_delta: number | null;
  match: {
    id: string;
    score_summary: string;
    played_at: string;
    match_type: string;
    result_status: string;
  } | null;
};

export default async function MyMatchesPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  // Pull all match participations for this player, with match details
  const { data: rawRows } = await supabase
    .from('match_participants')
    .select('id, win_flag, rating_delta, match:matches(id, score_summary, played_at, match_type, result_status)')
    .eq('player_id', player.id)
    .order('created_at', { ascending: false, referencedTable: 'matches' })
    .limit(200);

  const rows: MatchRow[] = (rawRows ?? []).map((r) => {
    const m = r.match as unknown;
    return {
      id: r.id,
      win_flag: r.win_flag,
      rating_delta: r.rating_delta,
      match: (Array.isArray(m) ? m[0] : m) ?? null,
    };
  });

  const total = rows.length;
  const wins = rows.filter((r) => r.win_flag === true).length;
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
  const bestWin =
    rows
      .filter((r) => r.win_flag === true)
      .reduce<{ delta: number; opp: string; date: string } | null>((acc, r) => {
        const delta = r.rating_delta ?? 0;
        if (!acc || delta > acc.delta) {
          return {
            delta,
            opp: '—',
            date: r.match ? new Date(r.match.played_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—',
          };
        }
        return acc;
      }, null) ?? null;

  // Longest win streak
  let longestStreak = 0;
  let currentStreak = 0;
  // rows are most-recent-first; iterate forward from oldest for streak calc
  for (const r of [...rows].reverse()) {
    if (r.win_flag === true) {
      currentStreak += 1;
      longestStreak = Math.max(longestStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  // Serialize for client filter
  const flatRows = rows.map((r) => ({
    id: r.id,
    win_flag: r.win_flag,
    rating_delta: r.rating_delta,
    match_type: r.match?.match_type ?? 'singles',
    score_summary: r.match?.score_summary ?? '—',
    played_at: r.match?.played_at ?? null,
  }));

  return (
    <>
      {/* Desktop-only route — on mobile, redirect to my-stats */}
      <div className="m-only" style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--text-secondary)' }}>
        <p style={{ fontSize: 13 }}>
          Match history is shown on the <a href="/my-stats" style={{ color: 'var(--red)' }}>profile page</a> on mobile.
        </p>
      </div>

      <div className="d-only">
        <DPageHead
          eyebrow="Season 02 · My Record"
          title="My Matches."
          meta={`${wins}W · ${total - wins}L · ${winRate}% win rate this season. Filter by format to break it down.`}
        />
        <MyMatchesFilter rows={flatRows} />
        <div className="d-stats-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', borderTop: '1px solid var(--border)' }}>
          <DStat
            label="Matches Played"
            value={total}
            delta="This season"
          />
          <DStat
            label="Best Win"
            value={
              bestWin ? (
                <span style={{ color: 'var(--success)' }}>+{bestWin.delta}</span>
              ) : (
                '—'
              )
            }
            delta={bestWin ? bestWin.date : 'No wins yet'}
          />
          <DStat
            label="Longest Streak"
            value={longestStreak}
            delta="Consecutive wins"
          />
        </div>
      </div>
    </>
  );
}

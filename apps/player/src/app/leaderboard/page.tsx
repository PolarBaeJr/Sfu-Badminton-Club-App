import { createServerSupabaseClient, getViewer } from '@/lib/supabase-server';
import LeaderboardClient, { type LeaderboardEntry, type LeaderboardRow } from './leaderboard-client';

// Public page (middleware allows /leaderboard for anon); get_leaderboard is
// anon-safe, so logged-out visitors see rankings with no "you" highlight.
export default async function LeaderboardPage() {
  const { player } = await getViewer();
  const meId = player?.id ?? null;

  const supabase = await createServerSupabaseClient();

  // One anon-safe RPC returns every leaderboard-eligible player with ratings
  // and tournament points. We fetch once and let the client filter/sort each
  // tab in memory (fast) instead of re-querying per tab.
  const { data } = await supabase.rpc('get_leaderboard');

  const entries: LeaderboardEntry[] = ((data ?? []) as LeaderboardRow[]).map((row) => ({
    id: row.id,
    full_name: row.name,
    handle: row.handle,
    avatar_url: row.avatar_url,
    status: row.status,
    ratings: {
      singles_elo: row.singles_elo,
      doubles_elo: row.doubles_elo,
      singles_wins: row.singles_wins,
      singles_losses: row.singles_losses,
      doubles_wins: row.doubles_wins,
      doubles_losses: row.doubles_losses,
      singles_provisional: row.singles_provisional,
      doubles_provisional: row.doubles_provisional,
      current_singles_streak: row.current_singles_streak,
      current_doubles_streak: row.current_doubles_streak,
    },
    _tournamentPoints: row.tournament_points,
  }));

  return <LeaderboardClient initialPlayers={entries} meId={meId} />;
}

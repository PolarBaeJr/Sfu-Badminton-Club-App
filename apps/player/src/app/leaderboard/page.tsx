import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { LeaderboardClient } from './leaderboard-client';

export type LeaderboardEntry = {
  id: string;
  full_name: string;
  avatar_url: string | null;
  status: string;
  ratings: {
    singles_elo: number;
    doubles_elo: number;
    singles_wins: number;
    singles_losses: number;
    doubles_wins: number;
    doubles_losses: number;
    singles_provisional: boolean;
    doubles_provisional: boolean;
  } | null;
  singles_trend: number | null;
  singles_trend_n: number;
  doubles_trend: number | null;
  doubles_trend_n: number;
};

type TrendRow = {
  player_id: string;
  match_type: 'singles' | 'doubles';
  sample_size: number;
  trend_sum: number;
};

export default async function LeaderboardPage() {
  const supabase = await createServerSupabaseClient();

  const [playerResult, trendsResult, currentPlayer] = await Promise.all([
    // TODO: Phase 10 — scope by organization_id once multi-club is supported.
    supabase
      .from('players')
      .select('id, full_name, avatar_url, status, ratings(*)')
      .eq('active_flag', true)
      .is('deleted_at', null)
      .not('status', 'in', '("pending_approval","suspended")'),
    supabase
      .from('leaderboard_trends')
      .select('player_id, match_type, sample_size, trend_sum'),
    getCurrentPlayer(),
  ]);

  const trendsByPlayer = new Map<string, { singles?: TrendRow; doubles?: TrendRow }>();
  for (const t of (trendsResult.data ?? []) as TrendRow[]) {
    const slot = trendsByPlayer.get(t.player_id) ?? {};
    slot[t.match_type] = t;
    trendsByPlayer.set(t.player_id, slot);
  }

  const players: LeaderboardEntry[] = (playerResult.data ?? [])
    .map((p) => {
      const trend = trendsByPlayer.get(p.id);
      return {
        ...p,
        ratings: Array.isArray(p.ratings) ? p.ratings[0] : p.ratings,
        singles_trend: trend?.singles?.trend_sum ?? null,
        singles_trend_n: trend?.singles?.sample_size ?? 0,
        doubles_trend: trend?.doubles?.trend_sum ?? null,
        doubles_trend_n: trend?.doubles?.sample_size ?? 0,
      };
    })
    .filter((p) => p.ratings !== null) as LeaderboardEntry[];

  return (
    <LeaderboardClient
      players={players}
      currentPlayerId={currentPlayer?.id ?? null}
    />
  );
}

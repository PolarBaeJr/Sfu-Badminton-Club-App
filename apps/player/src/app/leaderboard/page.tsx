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
};

export default async function LeaderboardPage() {
  const supabase = await createServerSupabaseClient();

  const [playerResult, currentPlayer] = await Promise.all([
    supabase
      .from('players')
      .select('id, full_name, avatar_url, status, ratings(*)')
      .eq('active_flag', true)
      .not('status', 'in', '("pending_approval","suspended")'),
    getCurrentPlayer(),
  ]);

  const players: LeaderboardEntry[] = (playerResult.data ?? [])
    .map((p) => ({
      ...p,
      ratings: Array.isArray(p.ratings) ? p.ratings[0] : p.ratings,
    }))
    .filter((p) => p.ratings !== null) as LeaderboardEntry[];

  return (
    <LeaderboardClient
      players={players}
      currentPlayerId={currentPlayer?.id ?? null}
    />
  );
}

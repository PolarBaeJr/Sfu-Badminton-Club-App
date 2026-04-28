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

export type TournamentPointsEntry = {
  id: string;
  full_name: string;
  avatar_url: string | null;
  status: string;
  total: number;
};

export default async function LeaderboardPage() {
  const supabase = await createServerSupabaseClient();

  const [playerResult, tournamentResult, currentPlayer] = await Promise.all([
    supabase
      .from('players')
      .select('id, full_name, avatar_url, status, ratings(*)')
      .eq('active_flag', true)
      .not('status', 'in', '("pending_approval","suspended")'),
    supabase
      .from('tournament_participants')
      .select('player_id, points, player:players(id, full_name, avatar_url, status)')
      .not('status', 'in', '("withdrawn","disqualified")')
      .gt('points', 0),
    getCurrentPlayer(),
  ]);

  const players: LeaderboardEntry[] = (playerResult.data ?? [])
    .map((p) => ({
      ...p,
      ratings: Array.isArray(p.ratings) ? p.ratings[0] : p.ratings,
    }))
    .filter((p) => p.ratings !== null) as LeaderboardEntry[];

  const pointsMap: Record<string, { player: TournamentPointsEntry; total: number }> = {};
  for (const p of tournamentResult.data ?? []) {
    const player = (p as any).player;
    if (!player) continue;
    const existing = pointsMap[p.player_id];
    if (existing) {
      existing.total += p.points ?? 0;
    } else {
      pointsMap[p.player_id] = {
        player: {
          id: player.id,
          full_name: player.full_name,
          avatar_url: player.avatar_url,
          status: player.status,
          total: 0,
        },
        total: p.points ?? 0,
      };
    }
  }

  const tournamentPoints: TournamentPointsEntry[] = Object.values(pointsMap)
    .map((entry) => ({ ...entry.player, total: entry.total }))
    .sort((a, b) => b.total - a.total);

  return (
    <LeaderboardClient
      players={players}
      tournamentPoints={tournamentPoints}
      currentPlayerId={currentPlayer?.id ?? null}
    />
  );
}

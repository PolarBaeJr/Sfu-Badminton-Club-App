import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = await createServerSupabaseClient();

  const [playerResult, tournamentResult] = await Promise.all([
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
  ]);

  const players = (playerResult.data ?? [])
    .map((p) => ({ ...p, ratings: Array.isArray(p.ratings) ? p.ratings[0] : p.ratings }))
    .filter((p) => p.ratings !== null);

  const pointsMap: Record<string, { player: { id: string; full_name: string; avatar_url: string | null; status: string }; total: number }> = {};
  for (const p of tournamentResult.data ?? []) {
    const playerRaw = (p as { player: unknown }).player;
    const player = (Array.isArray(playerRaw) ? playerRaw[0] : playerRaw) as
      | { id: string; full_name: string; avatar_url: string | null; status: string }
      | null;
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
        },
        total: p.points ?? 0,
      };
    }
  }
  const tournamentPoints = Object.values(pointsMap)
    .map((entry) => ({ ...entry.player, total: entry.total }))
    .sort((a, b) => b.total - a.total);

  return NextResponse.json({ players, tournamentPoints });
}

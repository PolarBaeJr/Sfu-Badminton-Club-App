import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

type TrendRow = {
  player_id: string;
  match_type: 'singles' | 'doubles';
  sample_size: number;
  trend_sum: number;
};

export async function GET() {
  const supabase = await createServerSupabaseClient();

  // TODO: Phase 10 — scope by organization_id once multi-club is supported.
  const [playersResult, trendsResult] = await Promise.all([
    supabase
      .from('players')
      .select('id, full_name, avatar_url, status, ratings(*)')
      .eq('active_flag', true)
      .is('deleted_at', null)
      .not('status', 'in', '("pending_approval","suspended")'),
    supabase
      .from('leaderboard_trends')
      .select('player_id, match_type, sample_size, trend_sum'),
  ]);

  const trendsByPlayer = new Map<string, { singles?: TrendRow; doubles?: TrendRow }>();
  for (const t of (trendsResult.data ?? []) as TrendRow[]) {
    const slot = trendsByPlayer.get(t.player_id) ?? {};
    slot[t.match_type] = t;
    trendsByPlayer.set(t.player_id, slot);
  }

  const players = (playersResult.data ?? [])
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
    .filter((p) => p.ratings !== null);

  return NextResponse.json({ players });
}

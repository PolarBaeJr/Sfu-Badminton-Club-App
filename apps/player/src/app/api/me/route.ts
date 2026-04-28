import { NextResponse } from 'next/server';
import { getCurrentPlayer } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const player = await getCurrentPlayer();
  if (!player) return NextResponse.json(null);
  const r = Array.isArray(player.ratings) ? player.ratings[0] : player.ratings;
  return NextResponse.json({
    id: player.id,
    full_name: player.full_name,
    avatar_url: player.avatar_url,
    status: player.status,
    singles_elo: r?.singles_elo ?? null,
    doubles_elo: r?.doubles_elo ?? null,
  });
}

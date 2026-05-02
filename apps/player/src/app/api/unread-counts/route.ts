import { NextResponse } from 'next/server';
import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const player = await getCurrentPlayer();
  if (!player) {
    return NextResponse.json({
      unreadNotifs: 0,
      unreadAnnouncements: 0,
      incomingChallenges: 0,
    });
  }

  const supabase = await createServerSupabaseClient();
  const [notifRes, annRes, readsRes, challengeRes] = await Promise.all([
    supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('player_id', player.id)
      .eq('read_flag', false),
    supabase
      .from('announcements')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'published'),
    supabase
      .from('announcement_reads')
      .select('*', { count: 'exact', head: true })
      .eq('player_id', player.id),
    supabase
      .from('challenge_participants')
      .select('challenge:challenges!inner(created_by)', { count: 'exact', head: true })
      .eq('player_id', player.id)
      .eq('confirmation_status', 'pending')
      .neq('challenge.created_by', player.id),
  ]);

  return NextResponse.json({
    unreadNotifs: notifRes.count ?? 0,
    unreadAnnouncements: Math.max(0, (annRes.count ?? 0) - (readsRes.count ?? 0)),
    incomingChallenges: challengeRes.count ?? 0,
  });
}

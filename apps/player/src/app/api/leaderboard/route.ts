import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = await createServerSupabaseClient();

  // TODO: Phase 10 — scope by organization_id once multi-club is supported.
  const { data } = await supabase
    .from('players')
    .select('id, full_name, avatar_url, status, ratings(*)')
    .eq('active_flag', true)
    .is('deleted_at', null)
    .not('status', 'in', '("pending_approval","suspended")');

  const players = (data ?? [])
    .map((p) => ({ ...p, ratings: Array.isArray(p.ratings) ? p.ratings[0] : p.ratings }))
    .filter((p) => p.ratings !== null);

  return NextResponse.json({ players });
}

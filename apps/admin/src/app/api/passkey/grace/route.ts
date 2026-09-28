import { NextResponse } from 'next/server';
import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import { consolePasskeyGrace } from '@/lib/passkey/grace';

export const dynamic = 'force-dynamic';

// Where the caller stands on the 14-day window without a console passkey
// (00262), for the banner. Under /api/passkey, so the gate itself never
// blocks it. Read-only: the middleware is what starts the window.
export async function GET() {
  let player;
  try {
    player = await getAuthenticatedConsoleUser({ skipPasskey: true });
  } catch {
    return NextResponse.json({ error: 'Not authorized' }, { status: 401 });
  }
  const headers = { 'Cache-Control': 'no-store' };
  const admin = createAdminClient();

  const { count, error } = await admin
    .from('passkey_credentials')
    .select('id', { count: 'exact', head: true })
    .eq('player_id', player.id)
    .eq('enrolled_via', 'admin');
  if (error) return NextResponse.json({ error: 'Unavailable' }, { status: 503, headers });
  if ((count ?? 0) >= 1) return NextResponse.json({ state: 'armed' }, { headers });

  if (!player.user_id) return NextResponse.json({ state: 'none' }, { headers });
  const { data: row, error: rowError } = await admin
    .from('console_passkey_grace')
    .select('started_at')
    .eq('user_id', player.user_id as string)
    .maybeSingle();
  if (rowError) return NextResponse.json({ error: 'Unavailable' }, { status: 503, headers });
  if (!row) return NextResponse.json({ state: 'none' }, { headers });

  const standing = consolePasskeyGrace(row.started_at, Date.now());
  if (!standing) return NextResponse.json({ state: 'none' }, { headers });
  if (standing.expired) return NextResponse.json({ state: 'expired' }, { headers });
  return NextResponse.json({ state: 'grace', daysLeft: standing.daysLeft }, { headers });
}

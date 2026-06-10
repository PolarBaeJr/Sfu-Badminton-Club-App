import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@badminton/shared/supabase-server';

// Admin app health check — same shape as the player app's so the same
// monitor config can hit both. See player/api/health/route.ts.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const startedAt = Date.now();
  const timestamp = new Date().toISOString();

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase
      .from('players')
      .select('id', { head: true, count: 'exact' })
      .limit(1);

    if (error) {
      return NextResponse.json(
        {
          status: 'degraded',
          timestamp,
          database: 'error',
          message: error.message,
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
        status: 'ok',
        timestamp,
        database: 'connected',
        latency_ms: Date.now() - startedAt,
      },
      { status: 200 }
    );
  } catch (err) {
    return NextResponse.json(
      {
        status: 'degraded',
        timestamp,
        database: 'error',
        message: err instanceof Error ? err.message : 'unknown error',
      },
      { status: 503 }
    );
  }
}

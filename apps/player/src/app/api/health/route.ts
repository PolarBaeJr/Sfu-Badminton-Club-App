import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';

// Lightweight health check. External uptime monitoring (UptimeRobot,
// Better Uptime, etc.) hits this. Tests Supabase reachability with a
// cheap HEAD-style query so a 200 means "the app's data path is alive",
// not just "Next is serving HTTP".
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const startedAt = Date.now();
  const timestamp = new Date().toISOString();

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase
      .from('players')
      .select('*', { head: true, count: 'exact' })
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

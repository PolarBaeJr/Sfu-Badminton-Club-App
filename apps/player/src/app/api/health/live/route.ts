import { NextResponse } from 'next/server';

// Never prerendered, never cached: a health endpoint that Next turned into a
// static 200 at build time would answer cheerfully from a container whose
// process is wedged, which is the whole thing these two routes exist to catch.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// LIVENESS — "is this process still answering HTTP?" and nothing more. It
// touches no database and reads no configuration, so it stays 200 through a
// Supabase outage. That is deliberate: the answer to "the database is down" is
// never "restart the web container".
//
// Its companion is ready/route.ts, which is what the compose healthcheck
// probes. Keep this one dependency-free — the pair is only useful because the
// two answer different questions, and an operator seeing live=200/ready=503
// knows immediately that the app is up and something it depends on is not.
//
// The body is a fixed shape on purpose. `status < 500` was the old test and it
// treated a 307 to /login, a 401 and a 404 from a wrong base path as healthy;
// callers must be able to assert on the payload, not just the status line.
export function GET() {
  return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}

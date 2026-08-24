import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Hard ceiling on the database probe. A slow dependency has to FAIL the check,
// not hang it: a probe that outlives its caller's timeout gets killed and
// reported as a failure anyway, but with no log line saying why.
//
// The binding constraint is the PROXY, not the compose healthcheck. There are
// two callers with very different patience:
//
//   compose healthcheck   timeout: 10s   (and it does not run on goproxy-*
//                                         replicas at all - see docker-compose.yml)
//   proxy.health probe    2s             (proxy-manager cmd/proxy/health.go,
//                                         healthTimeout, 5s interval)
//
// At 3000ms this was INVERTED against the proxy: on a database answering in
// 2-3s the proxy's context deadline fired first, so it recorded a transport
// error and marked the backend down while this route was still working and
// would have returned 200. Both player replicas share one database, so they
// would have flapped together - and zero healthy local backends is exactly the
// condition that triggers mesh failover to the Pi. A latency blip could have
// bounced the whole site to a failover host.
//
// 1500ms keeps the whole response inside the proxy's 2s budget with room for
// Next routing, so a slow database yields a clean, logged 503 instead of a
// silent timeout. Healthy round-trips here are tens of milliseconds.
// If proxy-manager's healthTimeout ever changes, re-check this number.
const PROBE_TIMEOUT_MS = 1500;

// Every refusal is this exact body — no version string, no configuration value,
// no error text. The route is deliberately unauthenticated (the healthcheck
// runs inside the container with no session), so anything it says is public.
// The reason goes to the container log, where an operator can read it and an
// anonymous caller cannot.
function notReady(reason: string) {
  console.warn(`readiness probe failed: ${reason}`);
  return NextResponse.json({ ok: false }, { status: 503, headers: { 'cache-control': 'no-store' } });
}

// READINESS — "can this container actually serve a request?" Two questions:
// the configuration it was built with parses, and the database answers.
//
// NEXT_PUBLIC_* values are inlined by Next at BUILD time, in server code too,
// so this reads the literal that was baked into the image rather than anything
// the runtime .env supplies. That is the point: an image built without a
// Supabase URL cannot be repaired by an env file, and this is where that shows
// up — at deploy, in the healthcheck, instead of in a member's browser.
export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return notReady('supabase url or anon key missing from the build');

  let origin: string;
  try {
    const parsed = new URL(supabaseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return notReady('supabase url is not http(s)');
    }
    origin = parsed.href.replace(/\/+$/, '');
  } catch {
    return notReady('supabase url does not parse');
  }

  try {
    // get_active_season() is the cheapest anon-executable call there is: a
    // SECURITY DEFINER lookup of one row, GRANTed to anon since 00003, and it
    // needs no session. An empty result is still a pass — this asks whether
    // PostgREST and Postgres are reachable, not what they hold.
    const response = await fetch(`${origin}/rest/v1/rpc/get_active_season`, {
      method: 'POST',
      // redirect: 'manual' on the probe's OWN request, not just on the
      // healthcheck. NEXT_PUBLIC_SUPABASE_URL points back through the public
      // proxy, so a proxy misconfiguration can answer /supabase with a 3xx to
      // an HTML page; fetch would follow it and hand back a cheerful 200. Same
      // trap pg_net fell into with /api/cron and SNS fell into with the SES
      // webhook — a followed redirect is why both reported success for months.
      redirect: 'manual',
      cache: 'no-store',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${anonKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Exactly 200. A 3xx (now visible, thanks to redirect: 'manual'), a 401
    // from a stale anon key and a 404 from a wrong path all mean not ready.
    if (response.status !== 200) return notReady(`supabase answered ${response.status}`);
    // And it has to be JSON. A 200 carrying an HTML login page is the failure
    // shape the status check alone cannot see.
    await response.json();
  } catch {
    return notReady('supabase unreachable or too slow');
  }

  return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}

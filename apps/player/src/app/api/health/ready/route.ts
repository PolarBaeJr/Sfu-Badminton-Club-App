import { NextResponse } from 'next/server';
import { getServerSupabaseUrl } from '@badminton/shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Hard ceiling on the database probe. A slow dependency has to FAIL the check,
// not hang it: a probe that outlives its caller's timeout gets killed and
// reported as a failure anyway, but with no log line saying why.
//
// The binding constraint is the reverse proxy's health probe, not the
// container healthcheck: the proxy gives this route about 2s, the container
// healthcheck 10s. A probe that outlived the proxy's deadline would be
// recorded as a transport error and the backend marked down while this route
// was still working, and because every replica shares one database they would
// all flap together. 1500ms keeps the whole response inside the 2s budget with
// room for Next routing, so a slow database yields a clean, logged 503 instead
// of a silent timeout. If the proxy's probe timeout changes, re-check this.
//
// SIZING THIS NUMBER. With SUPABASE_INTERNAL_URL set the probe is a direct call
// to the Supabase gateway over the private network, a few milliseconds. Unset,
// it goes to the PUBLIC origin in NEXT_PUBLIC_SUPABASE_URL, out through the
// edge and back in, which costs what an external client pays (tens to low
// hundreds of ms). 1500ms covers the slow path with roughly 10x headroom.
//
// The internal URL matters for more than latency. Through the public edge this
// probe also fails whenever the edge does, so every backend reports unhealthy
// at once even when the app and the database are fine. Calling the gateway
// directly makes it ask what a readiness probe should ask, "can THIS container
// reach the database", rather than "is the edge healthy". Without it, treat a
// simultaneous all-backends-unhealthy event as "suspect the edge first".
// WHAT THIS PROBE DELIBERATELY DOES NOT CHECK: whether the database is at the
// schema this image expects (F-012).
//
// The audit asked for one of readiness or a separate preflight to be
// authoritative about schema compatibility. It is the preflight —
// `./scripts/db-migrate.sh preflight <target>`, which compares
// supabase/migrations/.manifest.json against public.schema_migrations and
// refuses the promotion on any pending file, checksum drift, or a database
// ahead of the checkout.
//
// It cannot be this route, and the reason is in the paragraphs above. Readiness
// gates the proxy backend. A lagging database is the same for every replica at
// once, so failing here would empty the backend pool and hand the site to a
// failover host talking to the same database, which fails identically. A schema
// mismatch would become a total outage instead of a blocked promotion — and an
// outage nothing could clear except applying the migration under load.
//
// So this asks only what a readiness probe should: can THIS container reach the
// database. Schema compatibility is a release-time decision, made once, by a
// human, before the image is promoted.

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
// so the fallback reads the literal that was baked into the image rather than
// anything the runtime .env supplies. That is the point: an image built without
// a Supabase URL cannot be repaired by an env file, and this is where that shows
// up — at deploy, in the healthcheck, instead of in a member's browser.
//
// getServerSupabaseUrl() preserves that property exactly. SUPABASE_INTERNAL_URL
// is a runtime read and overrides when present; when it is absent or unusable
// the baked-in public literal is still what gets probed, so a bad build fails
// here as loudly as it always did.
export async function GET() {
  const supabaseUrl = getServerSupabaseUrl();
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
      // healthcheck. This still matters with an internal URL, and matters most
      // without one: the public origin points back through the proxy, so a
      // proxy misconfiguration can answer /supabase with a 3xx to
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

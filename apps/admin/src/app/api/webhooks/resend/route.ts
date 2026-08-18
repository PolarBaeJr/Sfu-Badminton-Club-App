import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase-server';

// Records Resend hard bounces and spam complaints so nothing is sent to that
// address again.
//
// WHY THIS EXISTS AT ALL. email_suppressions has been empty on production since
// it was created. Its only writers were the one-click unsubscribe link — which
// could not appear in any email, because EMAIL_UNSUBSCRIBE_SECRET was never set
// — and the SES webhook beside this one, which fails closed because
// SES_SNS_TOPIC_ARN is unset and SES was abandoned. So the club has been
// sending to hard-bounced addresses and to people who pressed "report spam",
// with nothing anywhere recording either. That is the exact behaviour that
// destroys a sending domain's reputation, and the first symptom is usually that
// legitimate mail stops arriving for everybody.
//
// The SES route is deliberately left in place rather than replaced: it is inert
// without its topic ARN, and deleting a working verifier for a provider that
// may come back is a worse trade than an unused file.
//
// THIS ENDPOINT IS PUBLIC AND UNAUTHENTICATED — Resend presents no session and
// no bearer token. Its only defence is the Svix signature, so verification is
// not a nicety: without it anyone who can POST here could suppress any member's
// address and silently cut them off from every notification the app sends.
// Every path below fails closed.
export const dynamic = 'force-dynamic';

/**
 * Svix's replay window. The signature covers the timestamp, so an attacker
 * cannot forge a fresh one — but a genuine request captured off the wire could
 * otherwise be replayed for ever. Five minutes is Svix's own recommendation and
 * is generous next to their delivery latency.
 */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Constant-time compare that does not leak length through an early return.
 * timingSafeEqual throws on a length mismatch, which is itself a side channel
 * and, more practically, a 500 instead of a 401.
 */
function signatureMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** One suppression to write, already lowercased. */
type Suppression = { email: string; reason: 'bounce' | 'complaint'; detail: unknown };

/**
 * WHICH EVENTS SUPPRESS, and — more importantly — which do not.
 *
 * `email.bounced` carries `data.bounce.type`, which is SES's classification
 * surfaced through Resend: 'Permanent', 'Transient' or 'Undetermined'. ONLY
 * Permanent suppresses. A Transient bounce is a full mailbox or a greylisting
 * server, and suppressing on one would permanently cut off a member whose inbox
 * was briefly full — an unrecoverable outcome for a temporary condition, since
 * nothing in this app removes a suppression. 'Undetermined' is treated as
 * transient for the same reason: the cost of a wrong Permanent is silence for
 * ever, and the cost of a wrong Transient is one more bounce.
 *
 * `email.complained` always suppresses. Somebody pressed "report spam"; there is
 * no ambiguity to weigh and continuing to mail them is what turns one complaint
 * into a domain-level reputation problem.
 *
 * Everything else — delivered, opened, clicked, delivery_delayed — is
 * acknowledged and ignored. Returning 200 for them matters: a non-2xx makes
 * Svix retry, so answering 4xx to an event we simply do not care about would
 * turn normal traffic into a retry storm.
 */
function extractSuppressions(event: unknown): Suppression[] {
  if (!event || typeof event !== 'object') return [];
  const e = event as { type?: unknown; data?: unknown };
  const type = String(e.type ?? '');
  const data = (e.data ?? {}) as { to?: unknown; bounce?: unknown };

  // `to` is an array on every Resend event, but a single string is accepted
  // too: a payload shape that changes underneath us must not silently record
  // nothing, and coercing here is cheaper than a bounce that goes unrecorded.
  const recipients = (Array.isArray(data.to) ? data.to : data.to ? [data.to] : [])
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean);
  if (recipients.length === 0) return [];

  if (type === 'email.bounced') {
    const bounce = (data.bounce ?? {}) as { type?: unknown };
    if (String(bounce.type ?? '') !== 'Permanent') return [];
    return recipients.map((email) => ({ email, reason: 'bounce' as const, detail: e.data }));
  }

  if (type === 'email.complained') {
    return recipients.map((email) => ({ email, reason: 'complaint' as const, detail: e.data }));
  }

  return [];
}

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  // 503, not 200. An unconfigured verifier cannot tell a real bounce from a
  // forged one, and answering OK would make Resend drop the event permanently —
  // the suppression would be lost rather than retried after the secret is set.
  if (!secret) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  // THE RAW BODY, read exactly once and never re-serialised. The signature is
  // over these bytes; `JSON.parse` then `JSON.stringify` round-trips key order
  // and whitespace and produces a string that can never match.
  const raw = await request.text();

  // Svix sends `svix-*`; its enterprise tier sends `webhook-*` for the same
  // three values. Accepting both costs nothing and avoids a silent outage if
  // the account is ever upgraded.
  const h = request.headers;
  const id = h.get('svix-id') ?? h.get('webhook-id');
  const timestamp = h.get('svix-timestamp') ?? h.get('webhook-timestamp');
  const signature = h.get('svix-signature') ?? h.get('webhook-signature');
  if (!id || !timestamp || !signature) {
    return new NextResponse('Missing signature headers', { status: 401 });
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    return new NextResponse('Bad timestamp', { status: 401 });
  }
  // Both directions: a timestamp far in the FUTURE is as much a forgery signal
  // as a stale one, and only checking the past half leaves the replay window
  // open to anyone who can set a clock forward.
  if (Math.abs(Math.floor(Date.now() / 1000) - sentAt) > TOLERANCE_SECONDS) {
    return new NextResponse('Timestamp outside tolerance', { status: 401 });
  }

  // `whsec_<base64>`. The key is the DECODED base64, not the literal string —
  // HMAC over the ASCII form verifies nothing that Svix ever signed, and would
  // fail closed on every request rather than loudly.
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${raw}`)
    .digest('base64');

  // The header holds space-separated `v<n>,<signature>` entries — more than one
  // during a secret rotation, when Svix signs with both the old and the new
  // key. Any v1 entry matching is a pass; unknown versions are skipped rather
  // than rejected, so a future scheme cannot break this endpoint.
  const ok = signature
    .split(' ')
    .filter((part) => part.startsWith('v1,'))
    .some((part) => signatureMatches(expected, part.slice(3)));
  if (!ok) {
    return new NextResponse('Bad signature', { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    // The signature already proved Resend sent this, so unparseable JSON is our
    // problem, not an attack. 400 rather than 500: retrying will not fix it.
    return new NextResponse('Bad JSON', { status: 400 });
  }

  const suppressions = extractSuppressions(event);
  if (suppressions.length === 0) return new NextResponse('OK', { status: 200 });

  const db = createAdminClient();
  const { error } = await db.from('email_suppressions').upsert(
    suppressions.map((s) => ({ email: s.email, reason: s.reason, detail: s.detail })),
    // The address is the primary key. A member who bounces twice must update
    // the row rather than 23505 into a retry loop.
    { onConflict: 'email' },
  );
  if (error) {
    // 500 so Svix retries. Losing a complaint silently is how a reputation
    // problem builds up unseen — the same reasoning the SES route gives.
    Sentry.captureException(new Error(`Resend suppression write failed: ${error.message}`));
    return new NextResponse('Write failed', { status: 500 });
  }

  return new NextResponse('OK', { status: 200 });
}

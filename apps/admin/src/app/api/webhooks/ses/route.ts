import { NextResponse } from 'next/server';
import { createVerify } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase-server';

// Receives SES bounce and complaint notifications over SNS and records the
// address so nothing is sent to it again.
//
// THIS ENDPOINT IS PUBLIC AND UNAUTHENTICATED — SNS will not present a secret.
// Its only defence is the message signature, so that verification is not a
// nicety: without it, anyone who can POST here could suppress any member's
// address and quietly lock them out of every notification the app sends. Every
// path below fails closed.
export const dynamic = 'force-dynamic';

// Certificates are only ever fetched from Amazon. Without this check the
// SigningCertURL in an attacker-supplied payload would make us fetch *their*
// certificate and then happily verify their signature against it — the whole
// scheme reduces to "trust the sender". Also an SSRF sink if left open.
function isAmazonUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return u.hostname === 'sns.amazonaws.com' || /\.amazonaws\.com$/.test(u.hostname);
}

// Fields and order are fixed by SNS; the signature is over exactly this string.
const SIGNED_FIELDS: Record<string, string[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

function canonical(msg: Record<string, unknown>): string | null {
  const fields = SIGNED_FIELDS[String(msg.Type)];
  if (!fields) return null;
  let out = '';
  for (const f of fields) {
    const v = msg[f];
    // Subject is genuinely optional and is omitted from the string when absent
    // — including it as empty produces a signature that never matches.
    if (v === undefined || v === null) continue;
    out += `${f}\n${String(v)}\n`;
  }
  return out;
}

const certCache = new Map<string, string>();

async function fetchCert(url: string): Promise<string | null> {
  const cached = certCache.get(url);
  if (cached) return cached;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const pem = await res.text();
    certCache.set(url, pem);
    return pem;
  } catch {
    return null;
  }
}

async function verifySignature(msg: Record<string, unknown>): Promise<boolean> {
  const certUrl = String(msg.SigningCertURL ?? '');
  if (!isAmazonUrl(certUrl)) return false;

  const body = canonical(msg);
  if (!body) return false;

  const pem = await fetchCert(certUrl);
  if (!pem) return false;

  // SignatureVersion 1 is SHA1, 2 is SHA256. Anything else is not something we
  // know how to check, so it does not get the benefit of the doubt.
  const version = String(msg.SignatureVersion ?? '');
  const algo = version === '1' ? 'RSA-SHA1' : version === '2' ? 'RSA-SHA256' : null;
  if (!algo) return false;

  try {
    const v = createVerify(algo);
    v.update(body, 'utf8');
    v.end();
    return v.verify(pem, String(msg.Signature ?? ''), 'base64');
  } catch {
    return false;
  }
}

// Pin to our own topic. A valid Amazon signature only proves the message came
// from SNS — not that it came from a topic we own. Without this, anyone could
// point their own topic at this URL and feed us whatever bounces they liked,
// all correctly signed, and suppress any member's address at will.
//
// An UNSET ARN used to return true, which meant this endpoint's only real
// defence was off by default — and it is unset on production today. It now
// fails closed. That trades one silent failure for another, though (nothing
// recorded, no bounces, complaint rate climbing exactly as before), so an
// unset ARN is reported as the deploy fault it is. A mismatched ARN is not:
// that is this check doing its job, and Sentry is for faults, not for
// validation working.
//
// Once per process, not once per request: this runs before the signature check
// on every POST, and SNS retries a rejected delivery, so a subscription created
// before the ARN is set would otherwise file a burst of identical events for
// one config mistake.
let arnFaultReported = false;

function topicAllowed(topicArn: unknown): boolean {
  const expected = process.env.SES_SNS_TOPIC_ARN;
  if (!expected) {
    if (!arnFaultReported) {
      arnFaultReported = true;
      Sentry.captureException(
        new Error('SES_SNS_TOPIC_ARN is not set — rejecting every SNS notification'),
      );
    }
    return false;
  }
  return String(topicArn) === expected;
}

interface Suppression {
  email: string;
  reason: 'bounce' | 'complaint';
  detail: Record<string, unknown>;
}

// Handles both the older SES notification shape (notificationType) and the
// event-publishing shape (eventType).
function extractSuppressions(raw: string): Suppression[] {
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }

  const kind = payload.notificationType ?? payload.eventType;

  if (kind === 'Bounce') {
    // Transient bounces are mailbox-full and the like — suppressing on those
    // would lock a member out of notifications over a temporary condition. Only
    // a permanent bounce means the address is genuinely dead.
    if (payload.bounce?.bounceType !== 'Permanent') return [];
    return (payload.bounce?.bouncedRecipients ?? [])
      .map((r: any) => r?.emailAddress)
      .filter((e: unknown): e is string => typeof e === 'string')
      .map((email: string) => ({
        email: email.trim().toLowerCase(),
        reason: 'bounce' as const,
        detail: {
          bounceType: payload.bounce?.bounceType,
          bounceSubType: payload.bounce?.bounceSubType,
          timestamp: payload.bounce?.timestamp,
        },
      }));
  }

  if (kind === 'Complaint') {
    // Every complaint counts, no threshold. Someone pressing "spam" is the
    // single most damaging signal to sender reputation.
    return (payload.complaint?.complainedRecipients ?? [])
      .map((r: any) => r?.emailAddress)
      .filter((e: unknown): e is string => typeof e === 'string')
      .map((email: string) => ({
        email: email.trim().toLowerCase(),
        reason: 'complaint' as const,
        detail: {
          complaintFeedbackType: payload.complaint?.complaintFeedbackType,
          timestamp: payload.complaint?.timestamp,
        },
      }));
  }

  return []; // Delivery, Send, Open, Click — nothing to suppress.
}

export async function POST(request: Request) {
  let msg: Record<string, unknown>;
  try {
    // SNS sends text/plain, so request.json() is not reliable here.
    msg = JSON.parse(await request.text());
  } catch {
    return new NextResponse('Bad request', { status: 400 });
  }

  if (!topicAllowed(msg.TopicArn)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  if (!(await verifySignature(msg))) {
    return new NextResponse('Invalid signature', { status: 403 });
  }

  // Only reached once the signature proves this really came from Amazon, so
  // confirming the subscription cannot be triggered by an outsider.
  if (msg.Type === 'SubscriptionConfirmation') {
    const subscribeUrl = String(msg.SubscribeURL ?? '');
    if (!isAmazonUrl(subscribeUrl)) return new NextResponse('Forbidden', { status: 403 });
    try {
      await fetch(subscribeUrl, { signal: AbortSignal.timeout(5000) });
    } catch (err) {
      Sentry.captureException(err, { extra: { step: 'ses-sns-subscribe-confirm' } });
      return new NextResponse('Could not confirm', { status: 500 });
    }
    return new NextResponse('Subscription confirmed', { status: 200 });
  }

  if (msg.Type !== 'Notification') {
    return new NextResponse('OK', { status: 200 });
  }

  const suppressions = extractSuppressions(String(msg.Message ?? ''));
  if (suppressions.length === 0) return new NextResponse('OK', { status: 200 });

  const db = createAdminClient();
  const { error } = await db.from('email_suppressions').upsert(
    suppressions.map((s) => ({ email: s.email, reason: s.reason, detail: s.detail })),
    { onConflict: 'email' },
  );
  if (error) {
    // 500 so SNS retries. Losing a complaint silently is how a reputation
    // problem builds up unseen.
    Sentry.captureException(new Error(`SES suppression write failed: ${error.message}`));
    return new NextResponse('Write failed', { status: 500 });
  }

  return new NextResponse('OK', { status: 200 });
}

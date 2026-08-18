// THE SIGNATURE IS THE ONLY THING GUARDING THIS ENDPOINT.
//
// /admin/api/webhooks/resend is public and unauthenticated — Resend presents no
// session and no bearer token, and the admin middleware exempts /api/webhooks/
// from the session check for exactly that reason. So every one of these tests
// is load-bearing in a way an ordinary route's tests are not: a verification
// bug here lets anyone POST an address and permanently cut that member off from
// every notification the club sends, with the suppression looking for all the
// world like a genuine bounce.
//
// The second half of the file is about WHICH events suppress. Getting that
// wrong is quieter and just as bad: suppress on a transient bounce and a member
// whose mailbox was briefly full never hears from the club again, because
// nothing in this app removes a suppression.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

const upsert = vi.fn();
vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: () => ({ from: () => ({ upsert }) }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const { POST } = await import('@/app/api/webhooks/resend/route');

const SECRET_B64 = Buffer.from('a-test-signing-key-32-bytes-long').toString('base64');
const SECRET = `whsec_${SECRET_B64}`;
const ID = 'msg_2abc';

function sign(body: string, timestamp: number, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return createHmac('sha256', key).update(`${ID}.${timestamp}.${body}`).digest('base64');
}

/** A signed request, correct unless a test deliberately breaks one part. */
function post(
  payload: unknown,
  opts: { timestamp?: number; signature?: string; headers?: Record<string, string> } = {},
) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const sig = opts.signature ?? `v1,${sign(body, ts)}`;
  return POST(
    new Request('https://console.example/admin/api/webhooks/resend', {
      method: 'POST',
      body,
      headers: {
        'svix-id': ID,
        'svix-timestamp': String(ts),
        'svix-signature': sig,
        ...opts.headers,
      },
    }),
  );
}

const bounced = (bounceType: string, to: string[] = ['member@sfu.ca']) => ({
  type: 'email.bounced',
  created_at: '2026-08-18T00:00:00.000Z',
  data: { email_id: 'e1', to, subject: 'Session reminder', bounce: { type: bounceType, subType: 'General', message: 'nope' } },
});

beforeEach(() => {
  upsert.mockReset();
  upsert.mockResolvedValue({ error: null });
  vi.stubEnv('RESEND_WEBHOOK_SECRET', SECRET);
});

describe('signature verification', () => {
  it('503s when the secret is unset, so Resend retries instead of dropping the event', async () => {
    // NOT 200. Answering OK would make Resend consider the bounce delivered and
    // discard it, so the suppression is lost rather than redelivered once the
    // secret is configured.
    vi.stubEnv('RESEND_WEBHOOK_SECRET', '');
    expect((await post(bounced('Permanent'))).status).toBe(503);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects a request with no signature headers', async () => {
    const res = await POST(
      new Request('https://console.example/admin/api/webhooks/resend', {
        method: 'POST',
        body: JSON.stringify(bounced('Permanent')),
      }),
    );
    expect(res.status).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects a forged signature', async () => {
    const res = await post(bounced('Permanent'), { signature: 'v1,' + Buffer.from('nonsense').toString('base64') });
    expect(res.status).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects a signature made with a different secret', async () => {
    const other = `whsec_${Buffer.from('a-different-key-of-32-bytes-len!').toString('base64')}`;
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify(bounced('Permanent'));
    const res = await post(body, { timestamp: ts, signature: `v1,${sign(body, ts, other)}` });
    expect(res.status).toBe(401);
  });

  it('rejects a replayed request outside the tolerance window', async () => {
    // Correctly signed — it was genuine once. The timestamp is what stops it
    // being replayed for ever off a captured wire.
    const res = await post(bounced('Permanent'), { timestamp: Math.floor(Date.now() / 1000) - 6 * 60 });
    expect(res.status).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects a timestamp in the future, not just a stale one', async () => {
    // Only checking the past half leaves the window open to anyone who can set
    // a clock forward.
    const res = await post(bounced('Permanent'), { timestamp: Math.floor(Date.now() / 1000) + 6 * 60 });
    expect(res.status).toBe(401);
  });

  it('verifies the RAW body, so a re-serialised payload fails', async () => {
    // The signature is over the exact bytes. This is the bug you get from
    // JSON.parse-then-JSON.stringify: same object, different string.
    const ts = Math.floor(Date.now() / 1000);
    const original = JSON.stringify(bounced('Permanent'));
    const reserialised = JSON.stringify(JSON.parse(original), null, 2);
    const res = await post(reserialised, { timestamp: ts, signature: `v1,${sign(original, ts)}` });
    expect(res.status).toBe(401);
  });

  it('accepts when any one of several v1 signatures matches, as during a rotation', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify(bounced('Permanent'));
    const stale = Buffer.from('an-old-keys-signature').toString('base64');
    const res = await post(body, { timestamp: ts, signature: `v1,${stale} v1,${sign(body, ts)}` });
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalled();
  });

  it('accepts the webhook-* header spelling as well as svix-*', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify(bounced('Permanent'));
    const res = await POST(
      new Request('https://console.example/admin/api/webhooks/resend', {
        method: 'POST',
        body,
        headers: {
          'webhook-id': ID,
          'webhook-timestamp': String(ts),
          'webhook-signature': `v1,${sign(body, ts)}`,
        },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('which events suppress', () => {
  it('records a permanent bounce', async () => {
    expect((await post(bounced('Permanent'))).status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      [expect.objectContaining({ email: 'member@sfu.ca', reason: 'bounce' })],
      { onConflict: 'email' },
    );
  });

  it('does NOT record a transient bounce', async () => {
    // A full mailbox or a greylisting server. Suppressing here would cut the
    // member off permanently for a temporary condition, and nothing in this app
    // removes a suppression.
    expect((await post(bounced('Transient'))).status).toBe(200);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('treats Undetermined as transient', async () => {
    // The cost of a wrong Permanent is silence for ever; the cost of a wrong
    // Transient is one more bounce.
    expect((await post(bounced('Undetermined'))).status).toBe(200);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('records a complaint with no ambiguity to weigh', async () => {
    const res = await post({
      type: 'email.complained',
      data: { email_id: 'e2', to: ['angry@sfu.ca'] },
    });
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      [expect.objectContaining({ email: 'angry@sfu.ca', reason: 'complaint' })],
      { onConflict: 'email' },
    );
  });

  it('lowercases the address, because the table is keyed on the canonical form', async () => {
    await post(bounced('Permanent', ['Mixed.Case@SFU.ca']));
    expect(upsert).toHaveBeenCalledWith(
      [expect.objectContaining({ email: 'mixed.case@sfu.ca' })],
      { onConflict: 'email' },
    );
  });

  it('records every recipient of a multi-address send', async () => {
    await post(bounced('Permanent', ['a@sfu.ca', 'b@sfu.ca']));
    expect(upsert.mock.calls[0]![0]).toHaveLength(2);
  });

  it('acknowledges events it does not care about instead of making Svix retry', async () => {
    // A non-2xx here would turn ordinary delivery traffic into a retry storm.
    for (const type of ['email.delivered', 'email.opened', 'email.clicked', 'email.delivery_delayed']) {
      const res = await post({ type, data: { to: ['member@sfu.ca'] } });
      expect(res.status).toBe(200);
    }
    expect(upsert).not.toHaveBeenCalled();
  });

  it('500s when the write fails, so the complaint is retried rather than lost', async () => {
    upsert.mockResolvedValue({ error: { message: 'connection reset' } });
    expect((await post(bounced('Permanent'))).status).toBe(500);
  });
});

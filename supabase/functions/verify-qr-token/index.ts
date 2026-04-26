// verify-qr-token edge function.
//
// POST { challengeId, token }
// - 200 { ok: true, challenge: { id, type, format, players: [...], expiresAt } }
// - 400 { ok: false, code: 'INVALID_TOKEN' | 'EXPIRED' | 'WRONG_STATUS' | 'ALREADY_SUBMITTED' }
//
// Called by the player app /submit route server-side. Uses the service role
// key so it can read the challenge row even for not-yet-authenticated users.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SECRET = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;

type ErrorCode = 'INVALID_TOKEN' | 'EXPIRED' | 'WRONG_STATUS' | 'ALREADY_SUBMITTED';

function bad(code: ErrorCode, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: false, code, ...extra }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifyToken(
  token: string,
  challengeId: string,
): Promise<{ ok: true } | { ok: false; code: 'INVALID_TOKEN' | 'EXPIRED' }> {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, code: 'INVALID_TOKEN' };
  }
  const [payloadB64, sigB64] = token.split('.', 2);
  if (!payloadB64 || !sigB64) return { ok: false, code: 'INVALID_TOKEN' };

  const expectedSigBytes = await hmacSha256(SECRET, payloadB64);
  const expectedSigB64 = base64urlEncode(expectedSigBytes);
  if (!constantTimeEqual(new TextEncoder().encode(sigB64), new TextEncoder().encode(expectedSigB64))) {
    return { ok: false, code: 'INVALID_TOKEN' };
  }

  let payload: { cid?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
  } catch {
    return { ok: false, code: 'INVALID_TOKEN' };
  }

  if (typeof payload?.cid !== 'string' || typeof payload?.exp !== 'number') {
    return { ok: false, code: 'INVALID_TOKEN' };
  }
  if (payload.cid !== challengeId) return { ok: false, code: 'INVALID_TOKEN' };
  if (payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, code: 'EXPIRED' };
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: { challengeId?: unknown; token?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad('INVALID_TOKEN');
  }

  const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
  const token = typeof body.token === 'string' ? body.token : '';
  if (!challengeId || !token) return bad('INVALID_TOKEN');

  const tokenCheck = await verifyToken(token, challengeId);
  if (!tokenCheck.ok) return bad(tokenCheck.code);

  const supabase = createClient(SUPABASE_URL, SECRET, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: challenge, error } = await supabase
    .from('challenges')
    .select(
      'id, type, format, status, qr_token, qr_expires_at, challenge_participants(player_id, team_side, player:players(id, full_name, user_id))',
    )
    .eq('id', challengeId)
    .single();

  if (error || !challenge) return bad('INVALID_TOKEN');

  if (challenge.qr_token !== token) return bad('INVALID_TOKEN');
  if (challenge.qr_expires_at && new Date(challenge.qr_expires_at) < new Date()) {
    return bad('EXPIRED');
  }
  if (challenge.status !== 'accepted') {
    if (challenge.status === 'completed' || challenge.status === 'disputed') {
      return bad('ALREADY_SUBMITTED', { status: challenge.status });
    }
    return bad('WRONG_STATUS', { status: challenge.status });
  }

  const { data: existingMatch } = await supabase
    .from('matches')
    .select('id, result_status')
    .eq('challenge_id', challengeId)
    .maybeSingle();

  if (existingMatch) {
    return bad('ALREADY_SUBMITTED', { matchId: existingMatch.id });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      challenge: {
        id: challenge.id,
        type: challenge.type,
        format: challenge.format,
        expiresAt: challenge.qr_expires_at,
        participants: challenge.challenge_participants,
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});

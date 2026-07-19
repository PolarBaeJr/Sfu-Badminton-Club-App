import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { z } from 'zod';
import { rateLimit, getClientIp, parseOrThrow } from '@badminton/shared';
import { createAdminClient, getAuthenticatedExecOrAdmin } from '@/lib/supabase-server';
import { logAdminAudit } from '@/lib/audit';
import { signPayload, verifyPayload } from '@/lib/passkey/cookie';
import {
  getRpId,
  getExpectedOrigin,
  PASSKEY_CHALLENGE_COOKIE,
  PASSKEY_VERIFIED_COOKIE,
  PASSKEY_COOKIE_PATH,
  VERIFIED_TTL_SECONDS,
} from '@/lib/passkey/config';

const bodySchema = z.object({
  credential: z.unknown(),
  nickname: z.string().trim().min(1).max(64).optional(),
});

function clearChallengeCookie(response: NextResponse) {
  response.cookies.set(PASSKEY_CHALLENGE_COOKIE, '', { path: PASSKEY_COOKIE_PATH, maxAge: 0 });
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rl = rateLimit(`passkey-reg-verify:${ip}`, 10, 60_000);
  if (!rl.success) {
    return new NextResponse('Too many requests', { status: 429 });
  }

  let player;
  try {
    player = await getAuthenticatedExecOrAdmin({ skipPasskey: true });
  } catch {
    return NextResponse.json({ error: 'Not authorized' }, { status: 401 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = parseOrThrow(bodySchema, await request.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      { status: 400 }
    );
  }

  // Consume the challenge cookie (single-use: cleared on every outcome).
  const cookieStore = await cookies();
  const token = cookieStore.get(PASSKEY_CHALLENGE_COOKIE)?.value;
  const challenge = token ? await verifyPayload(token) : null;
  if (!challenge || challenge.type !== 'reg' || challenge.sub !== player.user_id) {
    const response = NextResponse.json({ error: 'Registration challenge expired' }, { status: 400 });
    clearChallengeCookie(response);
    return response;
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.credential as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge as string,
      expectedOrigin: getExpectedOrigin(),
      expectedRPID: getRpId(),
      // We request userVerification 'preferred', so don't hard-require it here.
      requireUserVerification: false,
    });
  } catch {
    verification = null;
  }
  if (!verification?.verified || !verification.registrationInfo) {
    const response = NextResponse.json({ error: 'Passkey registration failed' }, { status: 400 });
    clearChallengeCookie(response);
    return response;
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  const adminClient = createAdminClient();
  const { data: row, error } = await adminClient
    .from('passkey_credentials')
    .insert({
      player_id: player.id,
      credential_id: credential.id,
      public_key: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? null,
      device_type: credentialDeviceType,
      backed_up: credentialBackedUp,
      nickname: body.nickname ?? null,
    })
    .select('id')
    .single();
  if (error || !row) {
    const response = NextResponse.json({ error: 'Failed to save passkey' }, { status: 500 });
    clearChallengeCookie(response);
    return response;
  }

  await logAdminAudit(adminClient, {
    actor_id: player.id,
    action_type: 'passkey_registered',
    target_type: 'passkey_credential',
    target_id: row.id,
    new_value: { nickname: body.nickname ?? null, device_type: credentialDeviceType },
    reason: 'Passkey enrolled',
  });

  // Fresh enrollment proves possession — mark the session verified too.
  const verifiedToken = await signPayload({ sub: player.user_id }, VERIFIED_TTL_SECONDS);
  const response = NextResponse.json({ ok: true });
  clearChallengeCookie(response);
  response.cookies.set(PASSKEY_VERIFIED_COOKIE, verifiedToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: PASSKEY_COOKIE_PATH,
    maxAge: VERIFIED_TTL_SECONDS,
  });
  return response;
}

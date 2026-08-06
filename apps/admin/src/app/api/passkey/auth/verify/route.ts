import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { z } from 'zod';
import { rateLimit, getClientIp, parseOrThrow } from '@badminton/shared';
import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
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
  credential: z.object({ id: z.string().min(1) }).passthrough(),
});

function clearChallengeCookie(response: NextResponse) {
  response.cookies.set(PASSKEY_CHALLENGE_COOKIE, '', { path: PASSKEY_COOKIE_PATH, maxAge: 0 });
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rl = rateLimit(`passkey-auth-verify:${ip}`, 10, 60_000);
  if (!rl.success) {
    return new NextResponse('Too many requests', { status: 429 });
  }

  let player;
  try {
    player = await getAuthenticatedConsoleUser({ skipPasskey: true });
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
  if (!challenge || challenge.type !== 'auth' || challenge.sub !== player.user_id) {
    const response = NextResponse.json({ error: 'Authentication challenge expired' }, { status: 400 });
    clearChallengeCookie(response);
    return response;
  }

  const adminClient = createAdminClient();
  const { data: stored } = await adminClient
    .from('passkey_credentials')
    .select('id, credential_id, public_key, counter, transports')
    .eq('credential_id', body.credential.id)
    .eq('player_id', player.id)
    .maybeSingle();
  if (!stored) {
    const response = NextResponse.json({ error: 'Unknown passkey' }, { status: 400 });
    clearChallengeCookie(response);
    return response;
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.credential as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge.challenge as string,
      expectedOrigin: getExpectedOrigin(),
      expectedRPID: getRpId(),
      credential: {
        id: stored.credential_id,
        publicKey: isoBase64URL.toBuffer(stored.public_key),
        counter: Number(stored.counter),
        transports: (stored.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      },
      // We request userVerification 'preferred', so don't hard-require it here.
      requireUserVerification: false,
    });
  } catch {
    verification = null;
  }
  if (!verification?.verified) {
    const response = NextResponse.json({ error: 'Passkey verification failed' }, { status: 400 });
    clearChallengeCookie(response);
    return response;
  }

  // Counter regression = possible cloned authenticator. Many passkeys
  // (iCloud/Google-synced) always report 0, so never fail on 0.
  const newCounter = verification.authenticationInfo.newCounter;
  if (newCounter > 0 && newCounter <= Number(stored.counter)) {
    await logAdminAudit(adminClient, {
      actor_id: player.id,
      action_type: 'passkey_counter_anomaly',
      target_type: 'passkey_credential',
      target_id: stored.id,
      old_value: { counter: Number(stored.counter) },
      new_value: { counter: newCounter },
      reason: 'Signature counter did not increase — possible cloned credential',
    });
    const response = NextResponse.json({ error: 'Passkey verification failed' }, { status: 400 });
    clearChallengeCookie(response);
    return response;
  }

  await adminClient
    .from('passkey_credentials')
    .update({ counter: newCounter, last_used_at: new Date().toISOString() })
    .eq('id', stored.id);

  await logAdminAudit(adminClient, {
    actor_id: player.id,
    action_type: 'passkey_verified',
    target_type: 'passkey_credential',
    target_id: stored.id,
    reason: 'Passkey login verified',
  });

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

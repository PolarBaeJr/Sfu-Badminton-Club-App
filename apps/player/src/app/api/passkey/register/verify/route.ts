import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { z } from 'zod';
import { parseOrThrow } from '@badminton/shared';
import { getCurrentPlayer, createServiceRoleClient } from '@/lib/supabase-server';
import { verifyPayload } from '@/lib/passkey/cookie';
import {
  getRpId,
  getExpectedOrigin,
  isPasskeyConfigured,
  PASSKEY_CHALLENGE_COOKIE,
  PASSKEY_COOKIE_PATH,
} from '@/lib/passkey/config';

const bodySchema = z.object({
  credential: z.object({ id: z.string().min(1) }).passthrough(),
  nickname: z.string().trim().max(60).optional(),
});

function clearChallengeCookie(response: NextResponse) {
  response.cookies.set(PASSKEY_CHALLENGE_COOKIE, '', { path: PASSKEY_COOKIE_PATH, maxAge: 0 });
}

export async function POST(request: Request) {
  if (!isPasskeyConfigured()) {
    return NextResponse.json({ error: 'Passkeys are not configured' }, { status: 503 });
  }

  const player = await getCurrentPlayer();
  if (!player) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  let body: z.infer<typeof bodySchema>;
  try {
    body = parseOrThrow(bodySchema, await request.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      { status: 400 }
    );
  }

  // Single-use challenge: cleared on every outcome, success included.
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
      response: body.credential as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge as string,
      expectedOrigin: getExpectedOrigin(),
      expectedRPID: getRpId(),
      // userVerification is requested as 'preferred', so don't hard-require it.
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

  // Service role: 00011 deliberately has no INSERT policy on this table.
  const { error } = await createServiceRoleClient()
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
      // Explicit rather than relying on the column default: this credential
      // must never arm the admin console's gate (00051).
      enrolled_via: 'player',
    });
  if (error) {
    const response = NextResponse.json({ error: 'Failed to save passkey' }, { status: 500 });
    clearChallengeCookie(response);
    return response;
  }

  const response = NextResponse.json({ ok: true });
  clearChallengeCookie(response);
  return response;
}

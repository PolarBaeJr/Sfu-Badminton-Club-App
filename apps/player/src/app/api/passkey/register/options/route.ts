import { NextResponse } from 'next/server';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { getClientIp } from '@badminton/shared';
import { sharedRateLimit } from '@/lib/rate-limit';
import { getCurrentPlayer, createServiceRoleClient } from '@/lib/supabase-server';
import { signPayload } from '@/lib/passkey/cookie';
import {
  getRpId,
  isPasskeyConfigured,
  PASSKEY_CHALLENGE_COOKIE,
  PASSKEY_COOKIE_PATH,
  CHALLENGE_TTL_SECONDS,
} from '@/lib/passkey/config';

export async function POST(request: Request) {
  if (!isPasskeyConfigured()) {
    return NextResponse.json({ error: 'Passkeys are not configured' }, { status: 503 });
  }

  const ip = getClientIp(request);
  const rl = await sharedRateLimit(`pk-reg-options:${ip}`, 10, 60_000);
  if (!rl.success) return new NextResponse('Too many requests', { status: 429 });

  // Enrolment requires an existing session — you prove who you are with an
  // emailed code or Google first, then bind a passkey to that account.
  const player = await getCurrentPlayer();
  if (!player) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { data: existing } = await createServiceRoleClient()
    .from('passkey_credentials')
    .select('credential_id, transports')
    .eq('player_id', player.id);

  const options = await generateRegistrationOptions({
    rpName: 'SFU Badminton',
    rpID: getRpId(),
    userID: new TextEncoder().encode(player.id),
    userName: player.email,
    userDisplayName: player.full_name || player.email,
    // Already-enrolled credentials, so the authenticator refuses to register
    // the same device twice instead of creating a silent duplicate.
    excludeCredentials: (existing ?? []).map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: {
      // REQUIRED, not 'preferred' as the admin gate uses. A non-discoverable
      // credential cannot be found without the server first naming it, and the
      // whole point here is signing in before we know who you are. Requiring it
      // means every passkey enrolled through this route can actually log in.
      residentKey: 'required',
      userVerification: 'preferred',
    },
  });

  const challengeToken = await signPayload(
    { challenge: options.challenge, sub: player.user_id, type: 'reg' },
    CHALLENGE_TTL_SECONDS
  );

  const response = NextResponse.json(options);
  response.cookies.set(PASSKEY_CHALLENGE_COOKIE, challengeToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: PASSKEY_COOKIE_PATH,
    maxAge: CHALLENGE_TTL_SECONDS,
  });
  return response;
}

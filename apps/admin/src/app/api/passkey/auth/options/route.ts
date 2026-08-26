import { NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import { signPayload } from '@/lib/passkey/cookie';
import { recordChallenge } from '@/lib/passkey/challenge-store';
import {
  getRpId,
  PASSKEY_CHALLENGE_COOKIE,
  PASSKEY_COOKIE_PATH,
  CHALLENGE_TTL_SECONDS,
} from '@/lib/passkey/config';

export async function POST(request: Request) {
  let player;
  try {
    player = await getAuthenticatedConsoleUser({ skipPasskey: true });
  } catch {
    return NextResponse.json({ error: 'Not authorized' }, { status: 401 });
  }

  const adminClient = createAdminClient();
  const { data: credentials } = await adminClient
    .from('passkey_credentials')
    .select('credential_id, transports')
    .eq('player_id', player.id);

  if (!credentials || credentials.length === 0) {
    return NextResponse.json({ error: 'No passkeys enrolled' }, { status: 400 });
  }

  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    allowCredentials: credentials.map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
    userVerification: 'preferred',
  });

  // Single-use record, server side (00181). Written BEFORE the cookie is
  // handed out, so a challenge the browser holds always has something for
  // the verify route to claim.
  await recordChallenge(adminClient, options.challenge, 'admin_stepup', player.user_id, CHALLENGE_TTL_SECONDS);

  const challengeToken = await signPayload(
    { challenge: options.challenge, sub: player.user_id, type: 'auth' },
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

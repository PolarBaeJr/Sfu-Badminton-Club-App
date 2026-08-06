import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { rateLimit, getClientIp } from '@badminton/shared';
import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import { signPayload, verifyPayload } from '@/lib/passkey/cookie';
import {
  getRpId,
  PASSKEY_CHALLENGE_COOKIE,
  PASSKEY_VERIFIED_COOKIE,
  PASSKEY_COOKIE_PATH,
  CHALLENGE_TTL_SECONDS,
} from '@/lib/passkey/config';

export async function POST(request: Request) {
  // Rate limit: 10 attempts per IP per minute (matches auth/callback)
  const ip = getClientIp(request);
  const rl = rateLimit(`passkey-reg-options:${ip}`, 10, 60_000);
  if (!rl.success) {
    return new NextResponse('Too many requests', { status: 429 });
  }

  let player;
  try {
    // skipPasskey: these handlers are how an unverified session gets verified.
    player = await getAuthenticatedConsoleUser({ skipPasskey: true });
  } catch {
    return NextResponse.json({ error: 'Not authorized' }, { status: 401 });
  }

  const adminClient = createAdminClient();
  const { data: existing } = await adminClient
    .from('passkey_credentials')
    .select('credential_id, transports')
    .eq('player_id', player.id);

  // Bootstrap rule: the FIRST passkey needs only a signed-in session; adding
  // another requires a fresh passkey-verified cookie.
  if ((existing?.length ?? 0) > 0) {
    const cookieStore = await cookies();
    const token = cookieStore.get(PASSKEY_VERIFIED_COOKIE)?.value;
    const payload = token ? await verifyPayload(token) : null;
    if (!payload || payload.sub !== player.user_id) {
      return NextResponse.json(
        { error: 'Adding another passkey requires logging in with an existing passkey' },
        { status: 403 }
      );
    }
  }

  const options = await generateRegistrationOptions({
    rpName: 'SFU Badminton Admin',
    rpID: getRpId(),
    userID: new TextEncoder().encode(player.id),
    userName: player.email,
    excludeCredentials: (existing ?? []).map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
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

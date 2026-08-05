import { NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { rateLimit, getClientIp } from '@badminton/shared';
import { signPayload } from '@/lib/passkey/cookie';
import {
  getRpId,
  isPasskeyConfigured,
  PASSKEY_CHALLENGE_COOKIE,
  PASSKEY_COOKIE_PATH,
  CHALLENGE_TTL_SECONDS,
} from '@/lib/passkey/config';

// Unauthenticated by design — this is the start of signing in.
export async function POST(request: Request) {
  if (!isPasskeyConfigured()) {
    return NextResponse.json({ error: 'Passkeys are not configured' }, { status: 503 });
  }

  const ip = getClientIp(request);
  const rl = rateLimit(`pk-login-options:${ip}`, 10, 60_000);
  if (!rl.success) return new NextResponse('Too many requests', { status: 429 });

  // allowCredentials is deliberately EMPTY. The alternative — asking for an
  // email first and returning that account's credential ids — would answer
  // "does this address have an account here", an enumeration oracle on a
  // membership list. Discoverable credentials let the authenticator choose,
  // so the server learns who you are only after a valid signature.
  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    userVerification: 'preferred',
  });

  const challengeToken = await signPayload(
    { challenge: options.challenge, type: 'login' },
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

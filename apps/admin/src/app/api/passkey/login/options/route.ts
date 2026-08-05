import { NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { rateLimit, getClientIp } from '@badminton/shared';
import { signPayload } from '@/lib/passkey/cookie';
import {
  getRpId,
  isPasskeyLoginConfigured,
  PASSKEY_LOGIN_CHALLENGE_COOKIE,
  PASSKEY_COOKIE_PATH,
  CHALLENGE_TTL_SECONDS,
} from '@/lib/passkey/config';

// Unauthenticated by design — this is the start of signing in, not the step-up
// gate under /api/passkey/auth. The middleware short-circuits /api/passkey/login/
// before it looks for a session; see apps/admin/src/middleware.ts.
export async function POST(request: Request) {
  if (!isPasskeyLoginConfigured()) {
    return NextResponse.json({ error: 'Passkeys are not configured' }, { status: 503 });
  }

  const ip = getClientIp(request);
  const rl = rateLimit(`admin-pk-login-options:${ip}`, 10, 60_000);
  if (!rl.success) return new NextResponse('Too many requests', { status: 429 });

  // allowCredentials is deliberately EMPTY, unlike the step-up route which knows
  // who you are and can list your credentials. The alternative here — asking for
  // an email first and returning that account's credential ids — would answer
  // "is this address an exec", an enumeration oracle on the club's leadership.
  // Discoverable credentials let the authenticator choose, so the server learns
  // who you are only after a valid signature.
  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    userVerification: 'preferred',
  });

  const challengeToken = await signPayload(
    { challenge: options.challenge, type: 'login' },
    CHALLENGE_TTL_SECONDS
  );

  const response = NextResponse.json(options);
  response.cookies.set(PASSKEY_LOGIN_CHALLENGE_COOKIE, challengeToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: PASSKEY_COOKIE_PATH,
    maxAge: CHALLENGE_TTL_SECONDS,
  });
  return response;
}

import { NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { signPayload } from '@/lib/passkey/cookie';
import { recordChallenge } from '@/lib/passkey/challenge-store';
import { createAdminClient } from '@/lib/supabase-server';
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

  // NOT RATE LIMITED HERE, for the same reasons as the player route. The
  // throttle is at the edge on the /admin/api/passkey prefix (60/min per client
  // IP, routes.json on the proxy); the in-app limiter that used to sit here was
  // a per-process Map and so enforced double its stated number across two
  // replicas. See docs/ops/rate-limits.md.
  //
  // It has to stay generous either way: the console login page auto-starts a
  // conditional (autofill) ceremony on every view (login/page.tsx), so one page
  // view costs one challenge whether or not a passkey is used, and a 429 also
  // breaks the explicit "Sign in with a passkey" BUTTON, which mints from this
  // same route. Throttling the default way in is the failure the limit exists
  // to avoid, not to cause.
  //
  // Being generous is safe because the response is not a secret: allowCredentials
  // is empty by design (see below), so an unauthenticated caller learns nothing
  // about who has console access no matter how many challenges they collect.
  // What actually guards sign-in is the signature check on /login/verify.
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

  // Single-use record, server side (00181). No user id: this is the
  // discoverable-credential flow, so who is signing in is not known until
  // the assertion comes back. The purpose still binds it to THIS flow, so a
  // login challenge cannot be presented to admin step-up.
  await recordChallenge(createAdminClient(), options.challenge, 'admin_login', null, CHALLENGE_TTL_SECONDS);

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

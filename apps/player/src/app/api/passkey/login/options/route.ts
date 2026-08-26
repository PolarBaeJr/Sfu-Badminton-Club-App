import { NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { getClientIp } from '@badminton/shared';
import { signPayload } from '@/lib/passkey/cookie';
import { recordChallenge } from '@/lib/passkey/challenge-store';
import { createServiceRoleClient } from '@/lib/supabase-server';
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

  // NOT RATE LIMITED HERE. The throttle for this route lives at the edge, on
  // the /api/passkey prefix (240/min per client IP, routes.json on the proxy),
  // and there is deliberately no second one in-process: the old in-app limiter
  // was a per-process Map, so with two player replicas it enforced double
  // whatever it claimed. See docs/ops/rate-limits.md.
  //
  // Whatever the number is, it has to stay generous, because this route is not
  // something a member opts into: /login starts a conditional (autofill)
  // request on every view, so one visit costs one challenge whether or not a
  // passkey is ever used, and a 429 does not merely skip the speculative offer
  // — it also breaks the "Sign in with a passkey" BUTTON, which mints its
  // challenge from this same route. Throttling the default way in is the
  // failure the limit exists to avoid, not to cause.
  //
  // Being generous is safe because the response is not a secret: allowCredentials
  // is empty by design (see below), so an unauthenticated caller learns nothing
  // about who has an account no matter how many challenges they collect. What
  // actually guards sign-in is the signature check on /login/verify.
  // allowCredentials is deliberately EMPTY. The alternative — asking for an
  // email first and returning that account's credential ids — would answer
  // "does this address have an account here", an enumeration oracle on a
  // membership list. Discoverable credentials let the authenticator choose,
  // so the server learns who you are only after a valid signature.
  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    userVerification: 'preferred',
  });

  // Single-use record, server side (00181). No user id: this is the
  // discoverable-credential flow, so who is signing in is not known until
  // the assertion comes back. The purpose still binds it to THIS flow, so a
  // login challenge cannot be presented to admin step-up.
  await recordChallenge(createServiceRoleClient(), options.challenge, 'player_login', null, CHALLENGE_TTL_SECONDS);

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

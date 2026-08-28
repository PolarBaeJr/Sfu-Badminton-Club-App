import { NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { rateLimit, getClientIp } from '@badminton/shared';
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

  // 60/min, raised from 10. This route stopped being something a member opts
  // into: /login now starts a conditional (autofill) request on every view, so
  // one visit costs one challenge whether or not a passkey is ever used.
  //
  // How much traffic 10 was actually rationing depends on what getClientIp can
  // resolve, and the pessimistic case is the one to size for. It prefers
  // `cf-connecting-ip` (the true client, when Cloudflare's header reaches the
  // container) and otherwise takes the RIGHTMOST x-forwarded-for hop — which is
  // whatever address our own edge saw, i.e. one value shared by everyone behind
  // it, degrading to 'unknown' if no header arrives at all. So the bucket is
  // per-member at best and effectively per-deployment at worst, and at worst 10
  // /min is ten page views for the entire club. A 429 here does not merely skip
  // the speculative offer either: it also breaks the "Sign in with a passkey"
  // BUTTON, which mints its challenge from this same route. Throttling the
  // default way in is the failure this limiter exists to avoid, not to cause.
  //
  // Safe to loosen because the response is not a secret: allowCredentials is
  // empty by design (see below), so an unauthenticated caller learns nothing
  // about who has an account no matter how many challenges they collect. The
  // limiter that actually guards sign-in is on /login/verify.
  const ip = getClientIp(request);
  const rl = rateLimit(`pk-login-options:${ip}`, 60, 60_000);
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

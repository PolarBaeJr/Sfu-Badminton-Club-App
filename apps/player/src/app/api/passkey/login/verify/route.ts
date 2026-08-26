import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { z } from 'zod';
import {
  rateLimit,
  getClientIp,
  parseOrThrow,
  AUTH_COOKIE_OPTIONS,
  hostOnlyAuthCookieClears,
} from '@badminton/shared';
import { getServerSupabaseUrl } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
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
});

function clearChallengeCookie(response: NextResponse) {
  response.cookies.set(PASSKEY_CHALLENGE_COOKIE, '', { path: PASSKEY_COOKIE_PATH, maxAge: 0 });
}

// Deliberately uniform. Distinguishing "no such passkey" from "bad signature"
// would tell an unauthenticated caller which credential ids exist.
function fail(status = 400) {
  const response = NextResponse.json({ error: 'Passkey sign-in failed' }, { status });
  clearChallengeCookie(response);
  return response;
}

/**
 * Completes a passkey sign-in and mints a real Supabase session.
 *
 * This is the only unauthenticated endpoint in either app that can produce a
 * session, so the rules it follows are worth stating plainly:
 *
 *  - Identity comes from the CREDENTIAL, never from the request body. The
 *    client sends a credential id; everything about who that is comes from the
 *    row it matches and the signature verifying against that row's public key.
 *  - The challenge cookie is single-use and cleared on every outcome.
 *  - A stored credential whose player has no linked auth user is refused —
 *    roster rows exist without logins, and one must never become a session.
 */
export async function POST(request: Request) {
  if (!isPasskeyConfigured()) {
    return NextResponse.json({ error: 'Passkeys are not configured' }, { status: 503 });
  }

  // Still tighter than the enrolment routes — this one is reachable pre-auth —
  // but 5/min was sized when a passkey was a rarely-used extra. It is now the
  // primary way in, and the whole club signs in within a few minutes of a
  // session starting. Whether that is five buckets or one depends on what
  // getClientIp can resolve (see the note in ../options/route.ts): if the
  // per-client header does not survive our edge, everyone behind it shares this
  // count and the sixth member through the door is told to try again later.
  //
  // 20 covers a door queue without meaningfully widening anything. Every
  // attempt needs a valid single-use challenge cookie minted by /login/options
  // AND a signature over that challenge; the cookie is cleared on every outcome
  // including failure, so an attempt cannot be retried against the same
  // challenge; and every failure is deliberately uniform, so there is no oracle
  // to grind. The options limiter above bounds how fast challenges can be
  // minted in the first place, which is the real ceiling on this route.
  const ip = getClientIp(request);
  const rl = rateLimit(`pk-login-verify:${ip}`, 20, 60_000);
  if (!rl.success) return new NextResponse('Too many requests', { status: 429 });

  let body: z.infer<typeof bodySchema>;
  try {
    body = parseOrThrow(bodySchema, await request.json());
  } catch {
    return fail();
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(PASSKEY_CHALLENGE_COOKIE)?.value;
  const challenge = token ? await verifyPayload(token) : null;
  if (!challenge || challenge.type !== 'login') return fail();

  const service = createServiceRoleClient();
  const { data: stored } = await service
    .from('passkey_credentials')
    .select('id, credential_id, public_key, counter, transports, player_id')
    .eq('credential_id', body.credential.id)
    .maybeSingle();
  if (!stored) return fail();

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
      requireUserVerification: false,
    });
  } catch {
    verification = null;
  }
  if (!verification?.verified) return fail();

  // Counter regression = possible cloned authenticator. Synced passkeys
  // (iCloud/Google) always report 0, so never fail on 0.
  const newCounter = verification.authenticationInfo.newCounter;
  if (newCounter > 0 && newCounter <= Number(stored.counter)) return fail();

  const { data: player } = await service
    .from('players')
    .select('id, user_id, status')
    .eq('id', stored.player_id)
    .maybeSingle();
  if (!player?.user_id) return fail();

  // The canonical address lives on the auth user, not players.email — the
  // session must be minted for whatever GoTrue actually knows this account as.
  const { data: authUser, error: authErr } = await service.auth.admin.getUserById(player.user_id);
  const email = authUser?.user?.email;
  if (authErr || !email) return fail();
  if (authUser.user?.banned_until) return fail(403);

  await service
    .from('passkey_credentials')
    .update({ counter: newCounter, last_used_at: new Date().toISOString() })
    .eq('id', stored.id);

  // GoTrue has no WebAuthn grant, so a session is minted the supported way:
  // generateLink produces a single-use token WITHOUT sending mail, and
  // verifyOtp redeems it on a cookie-writing client. The token never leaves
  // the server.
  const { data: link, error: linkErr } = await service.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  const hashedToken = link?.properties?.hashed_token;
  if (linkErr || !hashedToken) return fail(500);

  const response = NextResponse.json({ ok: true });
  clearChallengeCookie(response);

  const supabase = createServerClient(
    getServerSupabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options as any);
          });
          // Expire the old host-only cookie in the same response that mints the
          // domain-scoped one, so the two never coexist. Raw append because
          // ResponseCookies is keyed by name and would clobber the write above.
          hostOnlyAuthCookieClears(cookiesToSet).forEach((c) =>
            response.headers.append('set-cookie', c)
          );
        },
      },
    }
  );

  const { error: otpErr } = await supabase.auth.verifyOtp({
    token_hash: hashedToken,
    type: 'magiclink',
  });
  if (otpErr) return fail(500);

  return response;
}

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { z } from 'zod';
import { parseOrThrow, AUTH_COOKIE_NAME } from '@badminton/shared';
import { createAdminClient } from '@/lib/supabase-server';
import { accessLevelFor } from '@/lib/permissions';
import { logAdminAudit } from '@/lib/audit';
import { signPayload, verifyPayload } from '@/lib/passkey/cookie';
import {
  getRpId,
  getExpectedOrigin,
  isPasskeyLoginConfigured,
  PASSKEY_LOGIN_CHALLENGE_COOKIE,
  PASSKEY_VERIFIED_COOKIE,
  PASSKEY_COOKIE_PATH,
  VERIFIED_TTL_SECONDS,
} from '@/lib/passkey/config';

const bodySchema = z.object({
  credential: z.object({ id: z.string().min(1) }).passthrough(),
});

function clearChallengeCookie(response: NextResponse) {
  response.cookies.set(PASSKEY_LOGIN_CHALLENGE_COOKIE, '', {
    path: PASSKEY_COOKIE_PATH,
    maxAge: 0,
  });
}

// Deliberately uniform. Distinguishing "no such passkey" from "bad signature"
// from "that passkey belongs to an ordinary member" would each tell an
// unauthenticated caller something they should have to prove to learn. Same
// status, same body, every time. 500 is reserved for our own faults after the
// signature already checked out — those depend on nothing the caller supplied.
function fail(status = 400) {
  const response = NextResponse.json({ error: 'Passkey sign-in failed' }, { status });
  clearChallengeCookie(response);
  return response;
}

/**
 * Completes a passkey sign-in to the admin console and mints a real Supabase
 * session.
 *
 * This is the only unauthenticated endpoint in the admin app that can produce a
 * session, so the rules it follows are worth stating plainly:
 *
 *  - Identity comes from the CREDENTIAL, never from the request body. The client
 *    sends a credential id; everything about who that is comes from the row it
 *    matches and the signature verifying against that row's public key.
 *  - The challenge cookie is single-use and cleared on every outcome.
 *  - A credential whose player has no linked auth user is refused — roster rows
 *    exist without logins, and one must never become a session.
 *  - Only admins and execs get a session here, matching what /auth/callback
 *    already does for Google and magic-link (it signs an ordinary member back
 *    out and sends them to /unauthorized). The admin origin does not hand out
 *    sessions to people who have no business on it.
 */
export async function POST(request: Request) {
  if (!isPasskeyLoginConfigured()) {
    return NextResponse.json({ error: 'Passkeys are not configured' }, { status: 503 });
  }

  // NOT RATE LIMITED HERE. The throttle is at the edge on the /admin/api/passkey
  // prefix (60/min per client IP, routes.json on the proxy). A tight per-IP
  // number is actively harmful here: an exec team on shared campus NAT sits in
  // one bucket and could lock itself out of its own console with correct
  // credentials.
  //
  // What makes this safe is the same argument the player route documents, and
  // it never depended on the limit: an attempt needs a valid single-use
  // challenge cookie minted by /login/options AND a signature over it; the
  // cookie is cleared on every outcome including failure, so an attempt cannot
  // be retried against the same challenge; and every failure is uniform, so
  // there is no oracle to grind.
  let body: z.infer<typeof bodySchema>;
  try {
    body = parseOrThrow(bodySchema, await request.json());
  } catch {
    return fail();
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(PASSKEY_LOGIN_CHALLENGE_COOKIE)?.value;
  const challenge = token ? await verifyPayload(token) : null;
  if (!challenge || challenge.type !== 'login') return fail();

  const adminClient = createAdminClient();

  // Wrapped: an unreachable database must look like every other failure. Letting
  // it throw would turn "Supabase is down" into a 500 on a public endpoint, which
  // is both a worse error page and a signal the 400s don't otherwise give away.
  let stored;
  try {
    const { data } = await adminClient
      .from('passkey_credentials')
      .select('id, credential_id, public_key, counter, transports, player_id')
      .eq('credential_id', body.credential.id)
      .maybeSingle();
    stored = data;
  } catch {
    return fail();
  }
  if (!stored) return fail();

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.credential as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge.challenge as string,
      // The ADMIN app's own origin — a credential scoped to the parent RP ID is
      // usable from either app, but an assertion collected on the player origin
      // must not be replayable here.
      expectedOrigin: getExpectedOrigin(),
      // The shared registrable parent (sfubadminton.com), never the admin
      // hostname — see the long note in lib/passkey/config.ts.
      expectedRPID: getRpId(),
      credential: {
        id: stored.credential_id,
        publicKey: isoBase64URL.toBuffer(stored.public_key),
        counter: Number(stored.counter),
        transports: (stored.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      },
      // We request userVerification 'preferred', so don't hard-require it here.
      requireUserVerification: false,
    });
  } catch {
    verification = null;
  }
  if (!verification?.verified) return fail();

  // Counter regression = possible cloned authenticator. Synced passkeys
  // (iCloud/Google) always report 0, so never fail on 0.
  const newCounter = verification.authenticationInfo.newCounter;
  if (newCounter > 0 && newCounter <= Number(stored.counter)) {
    await logAdminAudit(adminClient, {
      actor_id: stored.player_id,
      action_type: 'passkey_counter_anomaly',
      target_type: 'passkey_credential',
      target_id: stored.id,
      old_value: { counter: Number(stored.counter) },
      new_value: { counter: newCounter },
      reason: 'Signature counter did not increase during passkey sign-in — possible cloned credential',
    });
    return fail();
  }

  const { data: player } = await adminClient
    .from('players')
    .select('id, user_id, role, is_exec, is_trainer')
    .eq('id', stored.player_id)
    .maybeSingle();
  if (!player?.user_id) return fail();
  // Same predicate as admin_access_level(): anyone with ANY console level may
  // sign in here. What they can then DO is decided per section and per action,
  // not at the door — a trainer with a passkey who could not use it would
  // simply have no way in.
  //
  // is_trainer must be in the select above as well as the test: a missing
  // column reads as undefined, type-checks fine, and silently locks trainers out.
  if (accessLevelFor(player) === null) return fail();

  // The canonical address lives on the auth user, not players.email — the
  // session must be minted for whatever GoTrue actually knows this account as.
  const { data: authUser, error: authErr } = await adminClient.auth.admin.getUserById(player.user_id);
  const email = authUser?.user?.email;
  if (authErr || !email) return fail();
  if (authUser.user?.banned_until) return fail();

  await adminClient
    .from('passkey_credentials')
    .update({ counter: newCounter, last_used_at: new Date().toISOString() })
    .eq('id', stored.id);

  // GoTrue has no WebAuthn grant, so a session is minted the supported way:
  // generateLink produces a single-use token WITHOUT sending mail, and verifyOtp
  // redeems it on a cookie-writing client. The token never leaves the server.
  const { data: link, error: linkErr } = await adminClient.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  const hashedToken = link?.properties?.hashed_token;
  if (linkErr || !hashedToken) return fail(500);

  const response = NextResponse.json({ ok: true });
  clearChallengeCookie(response);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: { name: AUTH_COOKIE_NAME },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options as any);
          });
        },
      },
    }
  );

  const { error: otpErr } = await supabase.auth.verifyOtp({
    token_hash: hashedToken,
    type: 'magiclink',
  });
  if (otpErr) return fail(500);

  // Satisfy the passkey gate too. The gate asks "has this person demonstrated
  // possession of their enrolled authenticator recently"; the answer is yes —
  // it was demonstrated seconds ago, by the very assertion that produced this
  // session, against the same credential row, the same RP ID and origin, over a
  // fresh single-use challenge. The enrol route already sets this cookie on the
  // same reasoning. Withholding it would bounce every passkey sign-in straight
  // to /unavailable to ask for the passkey a second time.
  //
  // Safe because the two identities cannot diverge: `sub` is the user_id derived
  // from the verified credential, and it is the same user_id the session above
  // was minted for. The middleware's `payload.sub !== user.id` check therefore
  // compares a value against itself.
  const verifiedToken = await signPayload({ sub: player.user_id }, VERIFIED_TTL_SECONDS);
  response.cookies.set(PASSKEY_VERIFIED_COOKIE, verifiedToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: PASSKEY_COOKIE_PATH,
    maxAge: VERIFIED_TTL_SECONDS,
  });

  await logAdminAudit(adminClient, {
    actor_id: player.id,
    action_type: 'passkey_login',
    target_type: 'passkey_credential',
    target_id: stored.id,
    reason: 'Signed in to the admin console with a passkey',
  });

  return response;
}

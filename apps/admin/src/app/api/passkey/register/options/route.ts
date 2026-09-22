import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import { signPayload, verifyPayload } from '@/lib/passkey/cookie';
import { recordChallenge } from '@/lib/passkey/challenge-store';
import {
  getRpId,
  PASSKEY_CHALLENGE_COOKIE,
  PASSKEY_VERIFIED_COOKIE,
  PASSKEY_COOKIE_PATH,
  CHALLENGE_TTL_SECONDS,
} from '@/lib/passkey/config';

export async function POST(request: Request) {
  let player;
  try {
    // skipPasskey: these handlers are how an unverified session gets verified.
    player = await getAuthenticatedConsoleUser({ skipPasskey: true });
  } catch {
    return NextResponse.json({ error: 'Not authorized' }, { status: 401 });
  }

  const adminClient = createAdminClient();
  // enrolled_via comes back because the two uses of this list want different
  // subsets of it, and conflating them is what 00051 was written about.
  const { data: existing, error: existingError } = await adminClient
    .from('passkey_credentials')
    .select('credential_id, transports, enrolled_via')
    .eq('player_id', player.id);

  // FAIL CLOSED, for the same reason assertPasskeyVerified does. This error was
  // discarded, so a failed read left `existing` undefined, the length test below
  // read that as "no passkeys yet", and the bootstrap branch opened. That is the
  // wrong direction: the branch is what stops a session holding nothing but an
  // email code from adding its own passkey to an account that already has one.
  // Not knowing whether a credential exists is not the same as knowing it does
  // not. The cost of being wrong this way is a retry; the other way it is an
  // account takeover that survives the password.
  if (existingError) {
    return NextResponse.json(
      { error: 'Cannot verify your passkey enrolment right now — please try again shortly' },
      { status: 503 }
    );
  }

  // Bootstrap rule: the FIRST passkey needs only a signed-in session; adding
  // another requires a fresh passkey-verified cookie.
  //
  // Counted over admin-enrolled credentials ONLY, because that is what arms the
  // gate — has_passkeys() (00051) and assertPasskeyVerified both filter on
  // enrolled_via, and this third copy of the question did not. A members'-app
  // passkey is a convenience that deliberately does not impose a second factor
  // here, so an officer holding one and nothing else is in the grace period
  // according to every gate, and was then refused by this route as though they
  // already had an admin credential to step up with. They had none, which made
  // the 403 unanswerable: the way to satisfy it is to log in with the passkey
  // this branch is claiming exists.
  //
  // 00051 exists because a player-app enrolment silently locked an exec out of
  // the console on 2026-08-05. This is the same confusion in the enrolment path
  // rather than the gate, and it fails in the same direction.
  const adminEnrolled = (existing ?? []).filter((c) => c.enrolled_via === 'admin');
  if (adminEnrolled.length > 0) {
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
    // Deliberately EVERY credential, not just the admin-enrolled ones the gate
    // above counts. This list is not a permission check: it tells the
    // authenticator which keys it already holds for this account so it refuses
    // to mint a duplicate on the same device. A members'-app passkey lives on
    // the same authenticator under the same RP ID, so filtering it out here
    // would invite exactly the duplicate this parameter exists to prevent.
    // Same column, opposite answer, one line apart: read the question before
    // making the two agree.
    excludeCredentials: (existing ?? []).map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });

  // Single-use record, server side (00181).
  await recordChallenge(adminClient, options.challenge, 'admin_register', player.user_id, CHALLENGE_TTL_SECONDS);

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

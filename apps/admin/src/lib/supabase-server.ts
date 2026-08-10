import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { PASSKEY_VERIFIED_COOKIE } from './passkey/config';
import { verifyPayload } from './passkey/cookie';
import { AUTH_COOKIE_OPTIONS, ExpectedError } from '@badminton/shared';
import {
  accessLevelFor,
  atLeast,
  permissionsOf,
  permits,
  EXEC_BASELINE,
  TRAINER_BASELINE,
  UNRESTRICTED,
  type AccessLevel,
  type Capability,
  type Permissions,
} from './permissions';

// NOTE: generated `Database` type is available from '@badminton/shared' but not
// applied here — see comments in apps/player/src/lib/supabase-server.ts.

async function createServerSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        // No companion host-only clear — see the note in the player app's
        // supabase-server.ts: next/headers' store cannot append a second
        // Set-Cookie for the same name, and the middleware catches duplicates.
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options as any)
            );
          } catch {
            // Server Component
          }
        },
      },
    }
  );
}

export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// Belt-and-braces mirror of the middleware passkey gate: once a player has
// enrolled at least one passkey, server actions also require the signed
// verified-cookie (zero passkeys = grace period, no requirement). The
// /api/passkey handlers opt out via { skipPasskey: true } — they must work
// while UNverified, otherwise enrolment/verification would deadlock.
async function assertPasskeyVerified(
  userId: string,
  playerId: string,
  adminClient: ReturnType<typeof createAdminClient>
) {
  const cookieStore = await cookies();
  const token = cookieStore.get(PASSKEY_VERIFIED_COOKIE)?.value;
  if (token) {
    const payload = await verifyPayload(token);
    if (payload && payload.sub === userId) return;
  }

  // Must match has_passkeys() in the database, which the middleware calls to
  // make the SAME decision. Only admin-enrolled credentials arm this gate — a
  // members'-app passkey is a convenience and must not impose a second factor
  // here (00051). Without the enrolled_via filter this duplicate count let the
  // middleware wave a request through and then threw from the server side,
  // which is how an exec lost the panel with the migration already applied.
  const { count } = await adminClient
    .from('passkey_credentials')
    .select('id', { count: 'exact', head: true })
    .eq('player_id', playerId)
    .eq('enrolled_via', 'admin');
  if ((count ?? 0) >= 1) {
    Sentry.setUser(null);
    throw new ExpectedError('Passkey verification required');
  }
}

// The one authenticated gate. `authorize` receives the level the caller's row
// resolves to AND the permissions it stores, and returns a user-facing denial,
// or null to admit them — so there is exactly one place that authenticates,
// checks standing and enforces the passkey, and the two public gates below
// differ only in the question they ask about the caller.
//
// The denial is spelled by the caller because the message is user-facing, and a
// trainer told "admin or exec access required" has been told the truth.
async function getAuthenticatedConsolePlayer(
  authorize: (level: AccessLevel | null, permissions: Permissions) => string | null,
  options: { skipPasskey?: boolean } = {}
) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    // Clear any Sentry user context left over from a previous request handler
    // sharing this Node process — avoids misattributing the next error.
    Sentry.setUser(null);
    throw new ExpectedError('Not authenticated');
  }

  const adminClient = createAdminClient();
  const { data: player } = await adminClient
    .from('players')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!player) {
    Sentry.setUser(null);
    throw new ExpectedError('No player record found');
  }
  // STANDING first, then level. Banning an exec used to leave their console
  // access completely intact: banPlayer writes only players.is_banned, and
  // removePlayer sets status/active_flag — none of which this gate read. So a
  // banned exec lost the members' app entirely and kept the admin console,
  // where reinstatePlayer is exec-level with no check that the target is not
  // the caller. They could unban themselves, and the audit row would name them
  // as the actor.
  //
  // The player app's requirePlayer() has always rejected these. This is the
  // same rule, and it should have been in both places from the start.
  if (player.is_banned) {
    Sentry.setUser(null);
    throw new ExpectedError('Account suspended pending reinstatement');
  }
  if (player.status === 'suspended' || player.status === 'pending_approval') {
    Sentry.setUser(null);
    throw new ExpectedError(
      player.status === 'suspended' ? 'Account suspended' : 'Account pending approval'
    );
  }
  // deleteMyAccount clears active_flag; a pending deletion should not keep the
  // console open either.
  if (player.active_flag === false) {
    Sentry.setUser(null);
    throw new ExpectedError('Account is inactive');
  }

  // Same resolution the middleware gets from admin_console_access(), through
  // the same two helpers — never a second inline copy of either rule. The row
  // comes from select('*'), so permissionsOf() sees all three columns once
  // 00087 is applied and none of them before, which is the state it reads as
  // "not narrowed".
  //
  // BEFORE the passkey check, not after: an exec calling an admin-only action
  // has always been told "admin access required" rather than being sent to
  // enrol a passkey first, and swapping the order would change what every
  // refused caller sees.
  const denial = authorize(accessLevelFor(player), permissionsOf(player));
  if (denial !== null) {
    Sentry.setUser(null);
    throw new ExpectedError(denial);
  }

  if (!options.skipPasskey) {
    await assertPasskeyVerified(user.id, player.id, adminClient);
  }

  Sentry.setUser({ id: player.id });
  return player;
}

// Kept for the places where "admin" is about the ACCOUNT rather than about an
// area of the club — nothing in the capability vocabulary describes "is this
// person an administrator of this installation".
export async function getAuthenticatedAdmin(options: { skipPasskey?: boolean } = {}) {
  return getAuthenticatedConsolePlayer(
    (level) => (atLeast(level, 'admin') ? null : 'Admin access required'),
    options,
  );
}

// The refusal a caller SEES, which is a separate question from the decision.
// The decision is plain set membership; this reads back the lowest level whose
// baseline holds the capability, so somebody turned away is told what would
// have been enough. It reproduces, byte for byte, the three messages the level
// gates used to produce — which is what keeps this refactor invisible from the
// outside as well as from the inside.
//
// THE NARROWED CASE IS ANSWERED FIRST, and it has to be: a restricted exec
// refused players.approve.write holds the exec level, so "admin or exec access
// required" is not merely unhelpful, it is false — they would read it as a bug
// and ask an admin to check a flag that is already set. Their level is not the
// problem; their permissions are, and only an admin can change them.
//
// Unreachable before anything is stored, because an unrestricted person's set
// IS their level baseline, so the three level messages below still cover every
// refusal the console can produce today.
function denialFor(
  level: AccessLevel | null,
  permissions: Permissions,
  capability: Capability,
): string {
  if (permissions.kind === 'restricted' && permits(level, UNRESTRICTED, capability)) {
    return 'Your permissions do not include this. Ask an admin.';
  }
  if (TRAINER_BASELINE.includes(capability)) return 'Admin console access required';
  if (EXEC_BASELINE.includes(capability)) return 'Admin or exec access required';
  return 'Admin access required';
}

// THE GATE. Every server action and every gated page read names the one
// capability its work requires, and holding it is the whole question — there is
// no minimum level to also get right. A trainer calling
// tournaments.manage.create.write is refused because that string is not in
// TRAINER_BASELINE, not because a rung was compared, and an admin is admitted
// because permits() short-circuits on the level before any set is consulted.
//
// The argument is a Capability, so a typo is a compile error at the call site.
// That is what replaced the old `portfolio` argument: it was required for the
// same reason — an optional one defaults to full access at every call site that
// forgets it — but it could only ever cut the console four ways.
//
// THE ROW IT RETURNS IS THE ROW IT AUTHENTICATED, and that matters beyond
// convenience: setPlayerPermissions derives the actor's own capability set from
// this return value and from nothing else. Grant closure is only worth anything
// if the actor's set is resolved server-side through the same path the gates
// use, and this is that path.
export async function requireCapability(
  capability: Capability,
  options: { skipPasskey?: boolean } = {},
) {
  return getAuthenticatedConsolePlayer(
    (level, permissions) =>
      permits(level, permissions, capability) ? null : denialFor(level, permissions, capability),
    options,
  );
}

// The bottom rung: anyone with any console access at all, asking no capability
// question. Only for surfaces that HAVE no capability — the layout shell, the
// dashboard, and the passkey routes, which must work while unverified.
export async function getAuthenticatedConsoleUser(options: { skipPasskey?: boolean } = {}) {
  return getAuthenticatedConsolePlayer(
    (level) => (atLeast(level, 'trainer') ? null : 'Admin console access required'),
    options,
  );
}

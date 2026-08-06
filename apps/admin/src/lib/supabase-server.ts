import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { PASSKEY_VERIFIED_COOKIE } from './passkey/config';
import { verifyPayload } from './passkey/cookie';
import { AUTH_COOKIE_OPTIONS, ExpectedError } from '@badminton/shared';
import { accessLevelFor, atLeast, type AccessLevel } from './permissions';

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

// The one authenticated gate. Callers name the MINIMUM level they need and the
// ordering lives in permissions.ts, so adding a fourth level never means
// widening a boolean condition here — which is how `role === 'admin' ||
// is_exec` would have grown a third clause and quietly admitted trainers to
// every exec action in the app.
//
// `denial` is spelled per level because the message is user-facing and a
// trainer told "admin or exec access required" has been told the truth.
async function getAuthenticatedAtLeast(
  required: AccessLevel,
  denial: string,
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
  // Same resolution the middleware gets from admin_access_level(), through the
  // same helper — never a second inline copy of the rule.
  if (!atLeast(accessLevelFor(player), required)) {
    Sentry.setUser(null);
    throw new ExpectedError(denial);
  }

  if (!options.skipPasskey) {
    await assertPasskeyVerified(user.id, player.id, adminClient);
  }

  Sentry.setUser({ id: player.id });
  return player;
}

export async function getAuthenticatedAdmin(options: { skipPasskey?: boolean } = {}) {
  return getAuthenticatedAtLeast('admin', 'Admin access required', options);
}

// Broader gate than getAuthenticatedAdmin: permits full admins OR execs.
// Used by exec-allowed domain actions (matches, sessions, tournaments,
// announcements, seasons, and every mutating action under /players). Admin-only
// actions keep getAuthenticatedAdmin.
//
// Deliberately NOT widened to trainers. A trainer may read the roster and write
// varsity notes; approving, editing, banning, creating and removing players are
// all exec work, and they all gate here. Widening this one function would have
// handed a trainer every exec power in the app in a single line.
export async function getAuthenticatedExecOrAdmin(options: { skipPasskey?: boolean } = {}) {
  return getAuthenticatedAtLeast('exec', 'Admin or exec access required', options);
}

// The bottom rung: anyone with any console access at all. Used by the read-only
// surfaces a trainer legitimately needs (the roster pages, the dashboard shell,
// their own passkey settings) and by the varsity-note actions, which are the one
// thing a trainer may actually write.
export async function getAuthenticatedConsoleUser(options: { skipPasskey?: boolean } = {}) {
  return getAuthenticatedAtLeast('trainer', 'Admin console access required', options);
}

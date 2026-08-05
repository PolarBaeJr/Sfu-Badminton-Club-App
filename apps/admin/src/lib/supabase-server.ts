import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { PASSKEY_VERIFIED_COOKIE } from './passkey/config';
import { verifyPayload } from './passkey/cookie';
import { AUTH_COOKIE_OPTIONS } from '@badminton/shared';

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

  const { count } = await adminClient
    .from('passkey_credentials')
    .select('id', { count: 'exact', head: true })
    .eq('player_id', playerId);
  if ((count ?? 0) >= 1) {
    Sentry.setUser(null);
    throw new Error('Passkey verification required');
  }
}

export async function getAuthenticatedAdmin(options: { skipPasskey?: boolean } = {}) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    // Clear any Sentry user context left over from a previous request handler
    // sharing this Node process — avoids misattributing the next error.
    Sentry.setUser(null);
    throw new Error('Not authenticated');
  }

  const adminClient = createAdminClient();
  const { data: player } = await adminClient
    .from('players')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!player) {
    Sentry.setUser(null);
    throw new Error('No player record found');
  }
  if (player.role !== 'admin') {
    Sentry.setUser(null);
    throw new Error('Admin access required');
  }

  if (!options.skipPasskey) {
    await assertPasskeyVerified(user.id, player.id, adminClient);
  }

  Sentry.setUser({ id: player.id });
  return player;
}

// Broader gate than getAuthenticatedAdmin: permits full admins OR execs.
// Used by exec-allowed domain actions (matches, sessions, tournaments,
// announcements, seasons). Admin-only actions keep getAuthenticatedAdmin.
export async function getAuthenticatedExecOrAdmin(options: { skipPasskey?: boolean } = {}) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    Sentry.setUser(null);
    throw new Error('Not authenticated');
  }

  const adminClient = createAdminClient();
  const { data: player } = await adminClient
    .from('players')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!player) {
    Sentry.setUser(null);
    throw new Error('No player record found');
  }
  if (player.role !== 'admin' && player.is_exec !== true) {
    Sentry.setUser(null);
    throw new Error('Admin or exec access required');
  }

  if (!options.skipPasskey) {
    await assertPasskeyVerified(user.id, player.id, adminClient);
  }

  Sentry.setUser({ id: player.id });
  return player;
}

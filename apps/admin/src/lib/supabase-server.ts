import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';

// NOTE: generated `Database` type is available from '@badminton/shared' but not
// applied here — see comments in apps/player/src/lib/supabase-server.ts.

export async function createServerSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
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

export async function getAuthenticatedAdmin() {
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

  Sentry.setUser({ id: player.id });
  return player;
}

// Broader gate than getAuthenticatedAdmin: permits full admins OR execs.
// Used by exec-allowed domain actions (matches, sessions, tournaments,
// announcements, seasons). Admin-only actions keep getAuthenticatedAdmin.
export async function getAuthenticatedExecOrAdmin() {
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

  Sentry.setUser({ id: player.id });
  return player;
}

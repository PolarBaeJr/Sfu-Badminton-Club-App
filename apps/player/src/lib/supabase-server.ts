import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { AUTH_COOKIE_NAME } from '@badminton/shared';

// NOTE: generated `Database` type is available from '@badminton/shared' but not
// applied to the clients here — typed clients flip many `select('*, foo(*)')`
// embeddings to `never` and would cascade into a per-query rewrite. Opt in
// per-file when narrowing a specific query.

// Service role client — bypasses RLS, use only for trusted server-side operations
export function createServiceRoleClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function createServerSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: { name: AUTH_COOKIE_NAME },
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

// The active season's public info (name + per-status fees), or null if none is
// active. Uses the anon-safe get_active_season() RPC so it works the same in
// authenticated and logged-out contexts.
export async function getActiveSeason(): Promise<{
  id: string;
  name: string;
  competitive_fee_cents: number;
  recreational_fee_cents: number;
} | null> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.rpc('get_active_season');
  return data?.[0] ?? null;
}

export async function getExecutives(): Promise<{
  id: string;
  name: string;
  exec_title: string | null;
  avatar_url: string | null;
}[]> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.rpc('get_executives');
  return data ?? [];
}

export async function getCurrentPlayer() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // Service role for the full row: migration 00032 revokes blanket SELECT on
  // players, and a column grant denies select('*') even on your own row. This
  // is safe because the filter is the user id from the verified session, never
  // anything the caller supplies — it can only ever return the caller's row.
  const { data: player } = await createServiceRoleClient()
    .from('players')
    .select('*, ratings(*), waiver_acceptances(document, version, accepted_at)')
    .eq('user_id', user.id)
    .maybeSingle();

  return player;
}

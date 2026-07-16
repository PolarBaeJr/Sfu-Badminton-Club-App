import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

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

export async function getCurrentPlayer() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: player } = await supabase
    .from('players')
    .select('*, ratings(*)')
    .eq('user_id', user.id)
    .maybeSingle();

  return player;
}

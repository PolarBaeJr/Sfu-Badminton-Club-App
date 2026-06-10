import 'server-only';
import { cache } from 'react';
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@badminton/shared/supabase-server';

// Generic Supabase client factories live in @badminton/shared. Role-gated
// helpers (player lookup, current user) stay app-local because admin and
// player have fundamentally different security postures: admin THROWS on
// missing auth/role so route handlers fail closed; player returns null so
// pages can render a logged-out / partial state. Merging them would force
// one app's posture on the other.

export { createServerSupabaseClient, createServiceRoleClient };

// Wrapped in `cache()` so multiple callers (layout + page + components) within
// one request share a single auth.getUser + DB lookup instead of round-tripping
// for each one.
export const getCurrentPlayer = cache(async () => {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // Service role for the row read: direct players SELECT is column-restricted
  // for authenticated (00032) and callers need the full own row (email, phone,
  // preferences). Keyed strictly on the verified auth user id.
  const { data: player } = await createServiceRoleClient()
    .from('players')
    .select('*, ratings(*)')
    .eq('user_id', user.id)
    .single();

  return player;
});

export const getCurrentUser = cache(async () => {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
});

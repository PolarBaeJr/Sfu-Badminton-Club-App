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

  const { data: player } = await supabase
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

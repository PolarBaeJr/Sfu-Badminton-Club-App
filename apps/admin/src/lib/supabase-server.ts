import 'server-only';
import { cache } from 'react';
import { setUser as sentrySetUser } from '@sentry/nextjs';
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@badminton/shared/supabase-server';

// Generic Supabase client factories live in @badminton/shared. Role-gated
// helpers (admin gate, player lookup) stay app-local because admin and player
// have fundamentally different security postures: admin THROWS on missing
// auth/role so route handlers fail closed; player returns null so pages can
// render a logged-out state. Merging them would force one app's posture on the
// other.

export { createServerSupabaseClient };

// Kept under the `createAdminClient` name so the existing 20+ callers don't
// need to be touched. The implementation is the shared service-role factory.
export const createAdminClient = createServiceRoleClient;

// Wrapped in `cache()` so server actions / pages that share a render dedupe
// the auth.getUser + admin lookup pair to one round-trip per request.
// Selecting only the columns actually used by callers (id, role, email, full_name).
export const getAuthenticatedAdmin = cache(async () => {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const adminClient = createAdminClient();
  const { data: player } = await adminClient
    .from('players')
    .select('id, role, email, full_name, user_id')
    .eq('user_id', user.id)
    .single();

  if (!player) throw new Error('No player record found');
  if (player.role !== 'admin') throw new Error('Admin access required');

  sentrySetUser({ id: player.id });
  return player;
});

export const getCurrentAdminUser = cache(async () => {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
});

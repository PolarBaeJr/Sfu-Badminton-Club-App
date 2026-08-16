// Runs daily via cron
// Anonymizes accounts whose 30-day deletion-retention window has elapsed
// (players.deletion_requested_at, migration 00012) and deletes their auth
// user. Matches, ratings, session_attendance, and waiver_acceptances are
// deliberately never touched — history and legal evidence stay, attributed
// to the anonymized row.

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';

const RETENTION_DAYS = 30;

Deno.serve(async (req) => {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const supabase = createServiceClient();

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // deletion_requested_at stays set after the purge (tombstone), so rows
  // already anonymized are excluded by their sentinel email instead.
  const { data: players, error } = await supabase
    .from('players')
    .select('id, user_id')
    .not('deletion_requested_at', 'is', null)
    .lt('deletion_requested_at', cutoff)
    .not('email', 'like', 'deleted+%@deleted.invalid');

  if (error) {
    console.error('purge-deleted-accounts error:', error);
    return jsonResponse({ error: error.message }, 500);
  }

  let purged = 0;
  const errors: string[] = [];

  for (const player of players ?? []) {
    // Purely personal artifacts and the auth user go first; the anonymizing
    // update runs last so a partial failure leaves the row eligible for
    // retry on the next run (idempotent per player).
    const { error: pushError } = await supabase
      .from('push_subscriptions').delete().eq('player_id', player.id);
    const { error: passkeyError } = await supabase
      .from('passkey_credentials').delete().eq('player_id', player.id);
    const { error: notifError } = await supabase
      .from('notifications').delete().eq('player_id', player.id);
    const depError = pushError ?? passkeyError ?? notifError;
    if (depError) {
      errors.push(`${player.id}: ${depError.message}`);
      continue;
    }

    if (player.user_id) {
      const { error: authError } = await supabase.auth.admin.deleteUser(player.user_id);
      // A missing auth user means a previous run already deleted it — fine.
      if (authError && authError.status !== 404) {
        errors.push(`${player.id} auth: ${authError.message}`);
        continue;
      }
    }

    const { error: anonError } = await supabase
      .from('players')
      .update({
        // Two parts, not one string: full_name is generated (00023), and these
        // regenerate the same 'Deleted Player' every reader already expects.
        first_name: 'Deleted',
        last_name: 'Player',
        display_name: null,
        email: `deleted+${player.id}@deleted.invalid`,
        phone: null,
        avatar_url: null,
        bio: null,
        // 00130 split the one bio into two. The deletion email promises "profile
        // photo and bio are erased for good", and an officer's exec_bio is words
        // they wrote about themselves just as much as bio is — so it is erased
        // here too, not merely hidden. active_flag: false already takes them off
        // /exec, but "off the page" is not what was promised.
        exec_bio: null,
        active_flag: false,
        user_id: null,
      })
      .eq('id', player.id);

    if (anonError) {
      errors.push(`${player.id}: ${anonError.message}`);
      continue;
    }

    purged++;
  }

  if (errors.length > 0) {
    console.error('purge-deleted-accounts partial failures:', errors);
  }
  console.log(`Purged ${purged} deleted account(s)`);
  return jsonResponse({ purged, errors });
});

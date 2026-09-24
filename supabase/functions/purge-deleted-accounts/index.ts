// Runs daily via cron
// Anonymizes accounts whose 30-day deletion-retention window has elapsed
// (players.deletion_requested_at, migration 00012) and deletes their auth
// user. Matches, ratings, session_attendance, and waiver_acceptances are
// deliberately never touched — history and legal evidence stay, attributed
// to the anonymized row.
//
// WHAT IS ERASED IS NO LONGER DECIDED HERE. It is _shared/anonymize.ts,
// shared with purge-inactive-accounts, because these lists were maintained by
// hand in two places and fell behind the schema in three separate ways: the
// FIELD list had missed `exec_photo_url` (a photo of the person's face, on
// /exec) and `handle` (their one chosen name, public and searchable) since
// 00130 and 00092; the TABLE list had missed `player_discord_links`, so an
// anonymised row stayed joined to a live Discord account; and nothing had ever
// honoured `feedback_reports`'s declared SET NULL. See that file for each.

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';
import {
  anonymizedPlayerFields,
  DELINKED_TABLES,
  PERSONAL_ARTIFACT_TABLES,
} from '../_shared/anonymize.ts';
import { eraseFeeProofs } from '../_shared/fee-proofs.ts';

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
    // Purely personal artifacts first, then the links, then the auth user; the
    // anonymizing update runs LAST so a partial failure leaves the row eligible
    // for retry on the next run (idempotent per player). The table lists are
    // _shared/anonymize.ts, for the same reason the field list is.
    let depError: { message: string } | null = null;
    for (const table of PERSONAL_ARTIFACT_TABLES) {
      const { error: tableError } = await supabase
        .from(table).delete().eq('player_id', player.id);
      if (tableError) {
        depError = tableError;
        break;
      }
    }
    if (depError) {
      errors.push(`${player.id}: ${depError.message}`);
      continue;
    }

    // Cut the link, keep the row. See DELINKED_TABLES: this is the FK action
    // the schema declares and that an UPDATE-only purge can never trigger.
    for (const table of DELINKED_TABLES) {
      const { error: unlinkError } = await supabase
        .from(table).update({ player_id: null }).eq('player_id', player.id);
      if (unlinkError) {
        depError = unlinkError;
        break;
      }
    }
    if (depError) {
      errors.push(`${player.id}: ${depError.message}`);
      continue;
    }

    // Payment screenshots (00248), while user_id still names their folder.
    const proofError = await eraseFeeProofs(supabase, player.id, player.user_id);
    if (proofError) {
      errors.push(`${player.id} fee proofs: ${proofError.message}`);
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
      .update(anonymizedPlayerFields(player.id))
      .eq('id', player.id);

    if (anonError) {
      errors.push(`${player.id}: ${anonError.message}`);
      continue;
    }

    purged++;
  }

  // THE AUDIT TRAILS, which the anonymising update above cannot reach.
  //
  // A purged member's email address survives in two places outside `players`:
  // `auth.audit_log_entries`, where GoTrue files the address in
  // payload.actor_username on every sign-in, and `public.audit_logs.old_value`,
  // where four admin actions wrote whole player rows. Neither is touched by
  // anything above, so "permanently anonymized" was false the moment it was
  // promised. Migration 00155 built the scrub and deliberately left it uncalled,
  // so that the deployed app never depended on a function the owner had not yet
  // applied. It is applied. This is that one-line call.
  //
  // ONCE, AFTER THE LOOP, AND NOT PER PLAYER. The function takes no arguments
  // and finds its own work, by two predicates that only become true after this
  // loop has run: an auth row whose actor_id no longer exists in `auth.users`,
  // and a players row with `user_id IS NULL AND email LIKE 'deleted+%'`. Called
  // inside the loop before the anonymising update, it would match nothing and
  // scrub nothing, while looking exactly like it had worked.
  //
  // Only when something was actually purged. The function scans both audit
  // tables, and running it nightly to find the zero rows that the usual empty
  // run produces is pure load.
  //
  // Not a `continue`-style failure either: every erasure above has already
  // landed, and the scrub is idempotent, so the next run that purges anybody
  // picks up whatever this one missed. Loud, and carries on.
  if (purged > 0) {
    const { data: scrubbed, error: scrubError } = await supabase.rpc('scrub_deleted_identity');
    if (scrubError) {
      errors.push(`scrub_deleted_identity: ${scrubError.message}`);
    } else {
      const rows = Array.isArray(scrubbed) ? scrubbed[0] : scrubbed;
      console.log(
        `Scrubbed identity from audit trails: ${rows?.auth_rows_scrubbed ?? 0} auth row(s), ` +
          `${rows?.audit_rows_scrubbed ?? 0} audit_logs row(s)`,
      );
    }
  }

  if (errors.length > 0) {
    console.error('purge-deleted-accounts partial failures:', errors);
  }
  console.log(`Purged ${purged} deleted account(s)`);
  return jsonResponse({ purged, errors });
});

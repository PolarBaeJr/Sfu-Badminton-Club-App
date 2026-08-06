// Runs daily via cron (host crontab -> ~/bin/run-edge-fn.sh).
//
// Anonymizes members who have been inactive longer than
// inactivity_rules.purge_after_days (365). This is the most destructive job in
// the repo, so read the two design decisions before changing anything.
//
// 1. IT ANONYMISES, IT DOES NOT DELETE.
// The row stays. Only the personal details are cleared, and the member keeps a
// stable anonymous identity ("Deleted Player") that every existing reader
// already renders. Deleting the row would be a data-integrity disaster rather
// than a privacy win: matches, ratings, head-to-heads, session_attendance and
// waiver_acceptances all reference players.id, so removing one player corrupts
// the record of every match they ever appeared in and silently rewrites the
// Elo history of everyone who played them. purge-deleted-accounts (the 30-day
// consent flow) reached the same conclusion for the same reason; this job is
// deliberately its twin.
//
// 2. IT WRITES first_name/last_name, NEVER full_name.
// players.full_name is GENERATED ALWAYS (00023) from first_name/last_name.
// Writing to it raises "column full_name can only be updated to DEFAULT" and
// aborts the whole UPDATE. The copy of purge-deleted-accounts deployed on prod
// has exactly this bug, and because the auth user is deleted BEFORE the
// anonymising update, its failure mode is the worst available: the login is
// destroyed and every field it was meant to erase — name, email, phone,
// avatar, bio — survives. The cron line sends stderr to /dev/null, so it has
// been failing silently. Do not reintroduce it here.
//
// SAFETY: DRY RUN IS THE DEFAULT.
// Writes happen only when PURGE_INACTIVE_ENABLED is exactly 'true'. Unset or
// anything else = report who WOULD be purged and change nothing. The variable
// does not exist in the prod function env today, so deploying this file cannot
// purge anybody; turning it on is a separate, deliberate act by a human. This
// is an env var rather than a request flag on purpose — run-edge-fn.sh POSTs
// with no body and no query string and discards the response, so a request
// flag would be unreachable from the scheduler and unswitchable in practice.

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';

Deno.serve(async (req) => {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const supabase = createServiceClient();
  const dryRun = Deno.env.get('PURGE_INACTIVE_ENABLED') !== 'true';

  // EVERY exclusion lives in the view (00064), not here: lapsed by the clock
  // longer ago than the setting, and not an admin, exec, banned, deletion-
  // pending, suspended/pending-approval, or already-anonymised row. Selecting
  // from it rather than rebuilding the predicate is the point — the dry run,
  // the real run and any hand-written "who would this hit?" query are then
  // guaranteed to be answering out of the same WHERE clause.
  const { data: candidates, error } = await supabase
    .from('purgeable_inactive_players')
    .select('id, user_id, inactive_since, purge_after_days');

  if (error) {
    console.error('purge-inactive-accounts error:', error);
    return jsonResponse({ error: error.message }, 500);
  }

  const eligible = candidates ?? [];

  if (dryRun) {
    // Reports and returns. No auth deletions, no anonymising updates, and no
    // audit rows — an audit trail of things that did not happen would make the
    // real history unreadable.
    console.log(
      `purge-inactive-accounts DRY RUN — ${eligible.length} account(s) WOULD be anonymised. ` +
        `Set PURGE_INACTIVE_ENABLED=true to arm. Candidates: ` +
        (eligible.length
          ? eligible.map((p) => `${p.id} (inactive since ${p.inactive_since})`).join(', ')
          : 'none'),
    );
    return jsonResponse({
      dry_run: true,
      would_purge: eligible.length,
      purge_after_days: eligible[0]?.purge_after_days ?? null,
      candidates: eligible.map((p) => ({ id: p.id, inactive_since: p.inactive_since })),
    });
  }

  let purged = 0;
  const errors: string[] = [];

  for (const player of eligible) {
    // Order matters and mirrors purge-deleted-accounts: purely personal
    // artifacts first, then the auth user, then the anonymising update LAST.
    // A partial failure therefore leaves the row still matching the view, so
    // the next night retries it — idempotent per player.
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
      // A missing auth user means a previous run already got this far — fine.
      if (authError && authError.status !== 404) {
        errors.push(`${player.id} auth: ${authError.message}`);
        continue;
      }
    }

    const { error: anonError } = await supabase
      .from('players')
      .update({
        // Two parts, never full_name — see the header. These regenerate the
        // same 'Deleted Player' that every existing reader expects.
        first_name: 'Deleted',
        last_name: 'Player',
        display_name: null,
        email: `deleted+${player.id}@deleted.invalid`,
        phone: null,
        avatar_url: null,
        bio: null,
        active_flag: false,
        user_id: null,
      })
      .eq('id', player.id);

    if (anonError) {
      errors.push(`${player.id}: ${anonError.message}`);
      continue;
    }

    // Audit AFTER the row is actually anonymised, so the log records what
    // happened rather than what was attempted. actor_id is null because no
    // human did this — a clock did, which is the same shape
    // 'auto_marked_inactive' uses.
    //
    // No PII in the audit row. Writing the name or email we just erased into a
    // permanent log would undo the erasure and leave it somewhere nobody
    // thinks to look.
    const { error: auditError } = await supabase.from('audit_logs').insert({
      actor_id: null,
      action_type: 'auto_purged_inactive',
      target_type: 'player',
      target_id: player.id,
      old_value: { anonymized: false },
      new_value: { anonymized: true },
      reason: `Inactive since ${player.inactive_since} (> ${player.purge_after_days} days)`,
    });
    if (auditError) {
      // Loud, but not a `continue`: the row IS anonymised and retrying would
      // find it excluded by the sentinel email. A silent gap in the audit log
      // for an irreversible action is the thing to shout about.
      errors.push(`${player.id} audit: ${auditError.message}`);
    }

    purged++;
  }

  if (errors.length > 0) {
    console.error('purge-inactive-accounts partial failures:', errors);
  }
  console.log(`Purged ${purged} inactive account(s)`);
  return jsonResponse({ dry_run: false, purged, errors });
});

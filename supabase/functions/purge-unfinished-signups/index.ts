// Runs daily via cron, the same way purge-inactive-accounts does
// (purge-inactive-accounts:1, which says host crontab -> ~/bin/run-edge-fn.sh).
//
// Deletes abandoned signup stubs: somebody signed in, got a players row from
// ensure_player_for_user, never entered a name or signed a waiver, and has not
// come back for 30 days. Every exclusion lives in the view
// purgeable_unfinished_signups (00233); read its header before changing
// anything here, because the one condition holding the whole thing up
// (first_name = '') is not obvious from this file.
//
// 1. THIS ONE DELETES WHERE ITS TWIN ANONYMISES, AND NO EMAIL IS EVER SENT.
// purge-inactive-accounts:7-16 keeps the row because a lapsed member is
// referenced by matches, ratings, session_attendance and waiver_acceptances, so
// removing them corrupts the record of every match they appeared in. A row that
// matches this view has none of that: no name, no waiver, no matches (the view
// checks match_participants explicitly). There is nobody to preserve and nobody
// to warn. A "your account will be deleted" notice would be the club's first
// and only email to a person who never finished signing up, so the row is
// simply removed.
//
// 2. THE 30 DAYS RUN FROM FIRST SIGN-IN, because created_at is never
// re-stamped. ensure_player_for_user returns at its already-linked fast path on
// every sign-in after the first (00132:344-350) and its claim arm writes only
// user_id and updated_at (00132:389-395), so nothing in the sign-in path ever
// touches created_at. The clock therefore starts when the stub was inserted,
// which for a stub is the moment of first sign-in, and coming back to look at
// the app without finishing onboarding does not restart it. Deliberate: the
// question is "has this person finished?", and thirty days of visits that never
// finish is the same answer as thirty days of silence.
//
// 3. THE DELETE ORDER IS INVERTED FROM BOTH EXISTING JOBS, and so is the
// position of the audit write. players row FIRST, then the audit row, then the
// auth user. Both existing jobs do the reverse of both, and both can afford to
// because the row they touch survives and the next night retries it. Nothing
// retries this one. See the comments in the loop, and do not "fix" either to
// match the twin.
//
// SAFETY: DRY RUN IS THE DEFAULT.
// Writes happen only when PURGE_UNFINISHED_ENABLED is exactly 'true'. Unset or
// anything else = report who WOULD be deleted and change nothing. An env var
// rather than a request flag for the same reason as its twin
// (purge-inactive-accounts:37-39): run-edge-fn.sh POSTs with no body and no
// query string and discards the response, so a request flag would be
// unreachable from the scheduler.
//
// THIS IS A NEW VARIABLE AND MUST NEVER BE PURGE_INACTIVE_ENABLED. Sharing the
// gate would mean the human act of arming ANONYMISATION of lapsed members also,
// silently and in the same keystroke, armed outright DELETION of rows here.
// Two irreversible jobs with different blast radii get two switches, and each
// has to be thrown on purpose.

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';

Deno.serve(async (req) => {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const supabase = createServiceClient();
  const dryRun = Deno.env.get('PURGE_UNFINISHED_ENABLED') !== 'true';

  // EVERY condition lives in the view (00233), not here. Rebuilding
  // `onboarding_completed = false AND first_name = ''` in TypeScript is exactly
  // the defect 00064:5-11 describes: two copies that drift, and the direction
  // they drift in deletes somebody. In particular a TS copy that reached for
  // the obvious two-column definition of an incomplete signup
  // (apps/admin/src/app/players/page.tsx:225) and left out the empty-name test
  // would delete every roster row an exec ever pre-added that was later claimed
  // at sign-in.
  const { data: candidates, error } = await supabase
    .from('purgeable_unfinished_signups')
    .select('id, user_id, created_at');

  if (error) {
    console.error('purge-unfinished-signups error:', error);
    return jsonResponse({ error: error.message }, 500);
  }

  const eligible = candidates ?? [];

  if (dryRun) {
    // Reports and returns. No deletions and no audit rows: an audit trail of
    // things that did not happen would make the real history unreadable.
    console.log(
      `purge-unfinished-signups DRY RUN: ${eligible.length} unfinished signup(s) WOULD be deleted ` +
        `after 30 days. Set PURGE_UNFINISHED_ENABLED=true to arm. Candidates: ` +
        (eligible.length
          ? eligible.map((p) => `${p.id} (signed up ${p.created_at})`).join(', ')
          : 'none'),
    );
    return jsonResponse({
      dry_run: true,
      would_purge: eligible.length,
      candidates: eligible.map((p) => ({ id: p.id, created_at: p.created_at })),
    });
  }

  let purged = 0;
  const errors: string[] = [];

  for (const player of eligible) {
    // THE players ROW GOES FIRST AND THE AUTH USER SECOND. This is the reverse
    // of purge-inactive-accounts:105-134 and purge-deleted-accounts:45-73, and
    // the reversal is the point, because those two END by leaving the row still
    // matching their view so a partial failure retries. This one cannot: the
    // row is what gets removed, so "what survives a crash between the two
    // deletes?" has to be answered the other way round.
    //
    // players.user_id is `REFERENCES auth.users(id) ON DELETE SET NULL`
    // (00001_schema.sql:152) and this job's predicate opens with
    // `user_id IS NOT NULL` (00233). So:
    //
    //   auth user first, then a failure  -> the SET NULL has already fired. The
    //     stub now has no login and no name, which makes it byte-identical to a
    //     roster row an exec pre-added and nobody ever claimed. It sits on the
    //     admin Needs Attention tab forever (players/page.tsx:221-224 puts
    //     exactly that shape there), it no longer matches this view, and no
    //     future run can ever see it again. Unrecoverable without hand SQL by
    //     somebody who knows to look.
    //
    //   players row first, then a failure -> an orphan auth user with no
    //     players row. Their next sign-in calls ensure_player_for_user, which
    //     finds nothing to claim and inserts a fresh stub (00132:530-531). The
    //     30 days restart, which is correct for somebody who just came back.
    //     Benign and self-healing, and it needs nobody's attention.
    //
    // One of those is a permanent invisible orphan and the other fixes itself,
    // so the order follows.
    //
    // NO DEPENDENT ROWS ARE PRE-DELETED, unlike
    // purge-inactive-accounts:110-115. A genuine stub's only dependent is the
    // ratings row ensure_player_for_user seeds alongside it (00132:544-548),
    // and that FK is ON DELETE CASCADE (00001:189), as are notifications
    // (00001:473), push_subscriptions (00001:648) and passkey_credentials
    // (00011:17) if any exist. Everything else pointing at players(id) is an
    // attribution column with no ON DELETE clause, so NO ACTION: banned_by
    // (00001:169), marked_by, author_id, checked_in_by, added_by,
    // result_entered_by, performed_by, and tournament_pairs.player1_id/
    // player2_id (00001:712-713). A stub holds none of those, so they are a
    // free last-ditch check that the row really was a stub: clearing them by
    // hand first would delete precisely the evidence that it was not.
    const { error: rowError } = await supabase
      .from('players')
      .delete()
      .eq('id', player.id);

    if (rowError) {
      // Loud, and `continue` rather than anything cleverer. But the WORDING is
      // gated on the SQLSTATE, because only one of the possible causes is the
      // predicate's fault and the other two send the reader somewhere else
      // entirely.
      errors.push(`${player.id}: ${rowError.message}`);
      if (rowError.code === '23503') {
        // A foreign-key refusal is not a transient fault. It is the database
        // saying this row is referenced by club history and therefore was never
        // an abandoned stub, which means the view's predicate is wrong and
        // wants a human, not a retry that eventually succeeds.
        console.error(
          `purge-unfinished-signups REFUSED to delete ${player.id}: it is referenced by ` +
            `club history, so it was not a stub: ${rowError.message}`,
        );
      } else {
        // Anything else and the cause is NOT the predicate. 42501 would mean
        // service_role has lost DELETE on players (no migration revokes it, but
        // no job in this repo has ever deleted a players row either, so nothing
        // has exercised the grant). 23514 would be the BEFORE DELETE arm of
        // guard_last_admin_role (00050:95-98), which only fires for
        // role = 'admin' and so should be unreachable through this view. Saying
        // "it was not a stub" for either would send somebody to 00233's WHERE
        // clause to look for a bug that is not there.
        console.error(
          `purge-unfinished-signups could not delete ${player.id} ` +
            `(SQLSTATE ${rowError.code ?? 'unknown'}), which is not the view predicate's ` +
            `doing: ${rowError.message}`,
        );
      }
      continue;
    }

    // THE AUDIT ROW GOES HERE, BETWEEN THE TWO DELETES, and that is the second
    // thing in this file that is not a mistake. It records the players
    // deletion, which has just succeeded and is irreversible. Writing it after
    // the auth delete would put it behind a call that can fail, and the
    // `continue` on that failure would skip it: the row would be permanently
    // gone with nothing recorded anywhere, because `errors` goes into a
    // response body run-edge-fn.sh discards and stderr goes to /dev/null on the
    // cron line (purge-inactive-accounts:25). The twin can afford to audit last
    // because its subject row survives and the next night retries it. This one
    // has no next night.
    //
    // actor_id is null because no human did this, a clock did, which is the
    // shape 'auto_purged_inactive' and 'auto_marked_inactive' already use.
    //
    // This row outlives its subject on purpose: audit_logs.target_id is a plain
    // UUID with no foreign key to players (00001:488), so it is not cascaded
    // away with the row it describes. That is the only record that this id ever
    // existed, and for the one job in the repo that actually removes a players
    // row it is the record that matters.
    //
    // No PII. The email is the only identifying thing a stub had, and writing
    // it into a permanent log would keep the one detail the deletion was
    // supposed to remove. created_at is the reason, which is what a reader
    // needs to check the 30 days were real.
    const { error: auditError } = await supabase.from('audit_logs').insert({
      actor_id: null,
      action_type: 'auto_purged_unfinished_signup',
      target_type: 'player',
      target_id: player.id,
      old_value: { onboarding_completed: false },
      new_value: { deleted: true },
      reason: `Signed up ${player.created_at}, never completed onboarding (> 30 days)`,
    });
    if (auditError) {
      // Loud, but not a `continue`: the row is already gone and there is
      // nothing to retry, because the next run cannot find it to try again. A
      // silent gap in the audit log for an irreversible deletion is the thing
      // to shout about.
      errors.push(`${player.id} audit: ${auditError.message}`);
    }

    if (player.user_id) {
      const { error: authError } = await supabase.auth.admin.deleteUser(player.user_id);
      // A missing auth user means a previous run already got this far, or the
      // person deleted it themselves, fine either way.
      //
      // Anything else is recorded and NOT skipped past with a `continue`. What
      // is left behind is an auth user with no players row, which their next
      // sign-in repairs by itself (see above), so there is nothing here for a
      // retry to fix and nothing to withhold the count for.
      if (authError && authError.status !== 404) {
        errors.push(`${player.id} auth: ${authError.message}`);
      }
    }

    // Counts players rows deleted, which is the irreversible act and the one
    // the audit row above describes. A row whose auth user survived is still
    // counted here and named in `errors`, rather than being silently dropped
    // from both.
    purged++;
  }

  if (errors.length > 0) {
    console.error('purge-unfinished-signups partial failures:', errors);
  }
  console.log(`Purged ${purged} unfinished signup(s)`);
  return jsonResponse({ dry_run: false, purged, errors });
});

-- =====================================================================
-- 00202 — the round-10 defects
-- =====================================================================
--
-- 00201 put every field writer on one advisory key. Codex's round-10 review
-- accepted that the architecture is now right and returned eight specific
-- defects on top of it, plus one this migration found on its own. They are
-- closable, and this is them.
--
-- DO NOT SPLIT THIS MIGRATION FROM 00177-00201 WHEN APPLYING TO PRODUCTION.
-- Item 1 below unblocks merge_players, which 00194 broke by adding a
-- player_id foreign key it never classified: merge_players_unhandled()
-- returns digest_deliveries and merge_players therefore raises on EVERY
-- call. That refusal is, right now, the only thing preventing item 2's
-- corruption. Applying the classification without the pair guard would make
-- a deterministic data-corruption path live the same day. They ship together
-- or not at all.
--
-- ---------------------------------------------------------------------
-- 1. digest_deliveries was never classified (found here, not by codex)
-- ---------------------------------------------------------------------
--
-- It is a per-account delivery log with PK (week_start, player_id) and an
-- ON DELETE CASCADE reference to players — structurally identical to
-- notifications, which has been disposable since 00163. The removed
-- account's rows go with the account; the survivor keeps their own. There
-- is no re-send hazard, because a deleted player is not in any future
-- digest run to be sent to.
BEGIN;

CREATE OR REPLACE FUNCTION public.merge_players_disposable()
 RETURNS TABLE(tbl text, col text)
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT * FROM (VALUES
    ('notifications',        'player_id'),   -- per-account delivery log
    ('push_subscriptions',   'player_id'),   -- device tokens, re-registered on next login
    ('calendar_feed_tokens', 'player_id'),   -- PK is player_id; survivor keeps theirs
    ('ratings',              'player_id'),   -- untouched base row; see header
    ('reliability_metrics',  'player_id'),   -- merged into the survivor's, then dropped
    ('digest_deliveries',    'player_id')    -- per-account delivery log (00194); added 00202
  ) AS t(tbl, col);
$function$;

-- ---------------------------------------------------------------------
-- 2. merge_players: the pair/pool duplicate (round-10 defect 2)
-- ---------------------------------------------------------------------
--
-- Wholesale replacement. Two changes, both marked "00202" in the body: the
-- pair half of the participant-rewrite condition, and the named refusal for
-- the remap edge that condition opens. Everything else is 00176's text.
--
-- One fact worth recording because the guard cannot show it:
-- tournament_pairs.player1_id and player2_id are NO ACTION, not CASCADE, so
-- merge_players_unhandled() -- which filters on confdeltype = 'c' -- is
-- structurally incapable of listing them. They protect themselves by making
-- the final DELETE fail, which is safe but says nothing useful. A merge where
-- the REMOVED account is itself in a pair still ends in a raw foreign-key
-- error; that is a separate finding and is written up rather than fixed here.
CREATE OR REPLACE FUNCTION public.merge_players(p_keep uuid, p_remove uuid, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_unhandled  TEXT;
  v_keep       players%ROWTYPE;
  v_remove     players%ROWTYPE;
  v_moved_user BOOLEAN := FALSE;
  v_kept       JSONB   := '{}'::jsonb;
  v_dropped    JSONB   := '{}'::jsonb;
  v_selfplay   UUID[];
  v_tselfplay  UUID[];
  v_review     JSONB   := NULL;
  v_n          BIGINT;
  v_recomputed INTEGER := 0;
BEGIN
  IF p_keep = p_remove THEN
    RAISE EXCEPTION 'Cannot merge a player into themselves';
  END IF;

  SELECT * INTO v_keep   FROM players WHERE id = p_keep;
  SELECT * INTO v_remove FROM players WHERE id = p_remove;

  IF v_keep.id IS NULL  THEN RAISE EXCEPTION 'Surviving player % not found', p_keep; END IF;
  IF v_remove.id IS NULL THEN RAISE EXCEPTION 'Player to remove % not found', p_remove; END IF;

  -- Guard: a CASCADE column nobody has classified would be deleted silently.
  -- Unchanged from 00079 — an unreviewed table is not a thing to flag, it is a
  -- thing nobody has thought about yet.
  SELECT string_agg(format('%s.%s', tbl, col), ', ') INTO v_unhandled
    FROM merge_players_unhandled();
  IF v_unhandled IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to merge: % has a CASCADE reference to players that merge_players does not handle. Classify it in 00079 (blocked, repointed, or disposable) before merging.',
      v_unhandled;
  END IF;

  -- Guard: two logins. Still refuses. The auth identity has to be moved onto the
  -- survivor's auth.users row first, or deleting the loser leaves an orphaned
  -- login that re-onboards into a third player row at next sign-in.
  IF v_keep.user_id IS NOT NULL AND v_remove.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'Both accounts have a login. Move or delete one auth identity first, then merge.';
  END IF;

  -- Guard: deletion_requested_at is a promise the club made to a member.
  IF v_remove.deletion_requested_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to merge: the account being removed has a deletion recorded (%). Cancel it from that member''s page first, or leave the row to the purge job.',
      v_remove.deletion_requested_at;
  END IF;

  -- ---- Self-play detection, BEFORE anything moves ----
  -- Both ids still distinct in match_participants here, which is the only point
  -- at which the overlap is visible.
  SELECT array_agg(DISTINCT a.match_id) INTO v_selfplay
    FROM match_participants a
    JOIN match_participants b ON b.match_id = a.match_id
   WHERE a.player_id = p_keep AND b.player_id = p_remove;

  -- ---- Repoint NO ACTION columns (DELETE would otherwise throw) ----
  UPDATE players                SET banned_by         = p_keep WHERE banned_by         = p_remove;
  UPDATE announcements          SET author_id         = p_keep WHERE author_id         = p_remove;
  UPDATE club_fees              SET marked_by         = p_keep WHERE marked_by         = p_remove;
  UPDATE tournament_audit_log   SET performed_by      = p_keep WHERE performed_by      = p_remove;
  UPDATE tournament_matches     SET result_entered_by = p_keep WHERE result_entered_by = p_remove;
  UPDATE tournament_pairs       SET added_by          = p_keep WHERE added_by          = p_remove;
  UPDATE tournament_pairs       SET checked_in_by     = p_keep WHERE checked_in_by     = p_remove;
  UPDATE tournament_participants SET added_by         = p_keep WHERE added_by          = p_remove;
  UPDATE tournament_participants SET checked_in_by    = p_keep WHERE checked_in_by     = p_remove;

  -- ---- Repoint SET NULL columns (preserve attribution) ----
  UPDATE audit_logs             SET actor_id          = p_keep WHERE actor_id          = p_remove;
  UPDATE disputes               SET resolved_by       = p_keep WHERE resolved_by       = p_remove;
  UPDATE legacy_tournament_participants SET partner_id = p_keep WHERE partner_id       = p_remove;
  UPDATE legal_documents        SET updated_by        = p_keep WHERE updated_by        = p_remove;
  UPDATE matches                SET confirmed_by      = p_keep WHERE confirmed_by      = p_remove;
  UPDATE matches                SET forfeit_player_id = p_keep WHERE forfeit_player_id = p_remove;
  UPDATE matches                SET submitted_by      = p_keep WHERE submitted_by      = p_remove;
  UPDATE platform_settings      SET updated_by        = p_keep WHERE updated_by        = p_remove;
  UPDATE session_attendance     SET marked_by         = p_keep WHERE marked_by         = p_remove;
  UPDATE sessions               SET host_player_id    = p_keep WHERE host_player_id    = p_remove;
  UPDATE tournaments            SET created_by        = p_keep WHERE created_by        = p_remove;
  UPDATE walkovers              SET admin_confirmed_by = p_keep WHERE admin_confirmed_by = p_remove;

  -- ---- Class 1: nothing can collide, so it all moves (NEW in 00163) ----
  UPDATE club_fees   SET player_id         = p_keep WHERE player_id         = p_remove;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('club_fees', v_n); END IF;

  UPDATE varsity_notes SET player_id       = p_keep WHERE player_id         = p_remove;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('varsity_notes', v_n); END IF;

  UPDATE challenges  SET created_by        = p_keep WHERE created_by        = p_remove;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('challenges_created', v_n); END IF;

  UPDATE disputes    SET opened_by         = p_keep WHERE opened_by         = p_remove;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('disputes_opened', v_n); END IF;

  UPDATE walkovers   SET forfeit_player_id = p_keep WHERE forfeit_player_id = p_remove;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('walkovers', v_n); END IF;

  -- ---- Existing CASCADE keeps, unchanged from 00079 ----
  UPDATE waiver_acceptances w SET player_id = p_keep
   WHERE w.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM waiver_acceptances k
                      WHERE k.player_id = p_keep AND k.document = w.document
                        AND k.version = w.version);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('waiver_acceptances', v_n); END IF;

  UPDATE event_waiver_acceptances e SET player_id = p_keep
   WHERE e.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM event_waiver_acceptances k
                      WHERE k.player_id = p_keep AND k.tournament_id = e.tournament_id
                        AND k.waiver_hash = e.waiver_hash);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('event_waiver_acceptances', v_n); END IF;

  -- player_discord_links: a SEPARATE, PRE-EXISTING BUG, fixed here because a
  -- plpgsql body cannot be patched in place and this file already restates the
  -- function. 00165 added the table with a CASCADE reference to players and
  -- never classified it, so merge_players_unhandled() has been returning it
  -- ever since -- which means the guard at the top of this function has been
  -- REFUSING EVERY MERGE on production since the Discord bot shipped. Verified
  -- against prod: merge_players_unhandled() returns exactly this one row.
  --
  -- The link is repointed, not dropped: it is the member's own Discord account
  -- and the surviving row is still the same human. PK is player_id and
  -- discord_user_id is UNIQUE, so when BOTH accounts have a link the survivor's
  -- wins and the loser's is left to CASCADE -- which fires
  -- trg_queue_discord_role_revocation and strips the stale account's roles,
  -- exactly the behaviour that is wanted.
  UPDATE player_discord_links l SET player_id = p_keep
   WHERE l.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM player_discord_links k WHERE k.player_id = p_keep);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('player_discord_links', v_n); END IF;
  SELECT count(*) INTO v_n FROM player_discord_links WHERE player_id = p_remove;
  IF v_n > 0 THEN v_dropped := v_dropped || jsonb_build_object('player_discord_links', v_n); END IF;

  UPDATE passkey_credentials SET player_id = p_keep WHERE player_id = p_remove;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('passkey_credentials', v_n); END IF;

  UPDATE announcement_reads a SET player_id = p_keep
   WHERE a.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM announcement_reads k
                      WHERE k.player_id = p_keep AND k.announcement_id = a.announcement_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('announcement_reads', v_n); END IF;

  -- ---- Class 2: move what fits, count what the survivor already had (NEW) ----
  -- Every one of these is UNIQUE (scope, player_id). The NOT EXISTS is what
  -- makes the merge total: without it the first overlapping scope raises a
  -- unique violation and the whole merge aborts, which is the behaviour 00079
  -- pre-empted with a guard rather than solved.
  -- The discarded count is recorded, not the rows: the rows are still readable
  -- in the audit_logs entry's old_value until the cascade, and an admin who
  -- needs the detail has the loser's id.

  UPDATE match_participants x SET player_id = p_keep
   WHERE x.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM match_participants k
                      WHERE k.player_id = p_keep AND k.match_id = x.match_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('match_participants', v_n); END IF;
  SELECT count(*) INTO v_n FROM match_participants WHERE player_id = p_remove;
  IF v_n > 0 THEN v_dropped := v_dropped || jsonb_build_object('match_participants', v_n); END IF;

  UPDATE challenge_participants x SET player_id = p_keep
   WHERE x.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM challenge_participants k
                      WHERE k.player_id = p_keep AND k.challenge_id = x.challenge_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('challenge_participants', v_n); END IF;
  SELECT count(*) INTO v_n FROM challenge_participants WHERE player_id = p_remove;
  IF v_n > 0 THEN v_dropped := v_dropped || jsonb_build_object('challenge_participants', v_n); END IF;

  UPDATE session_attendance x SET player_id = p_keep
   WHERE x.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM session_attendance k
                      WHERE k.player_id = p_keep AND k.session_id = x.session_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('session_attendance', v_n); END IF;
  SELECT count(*) INTO v_n FROM session_attendance WHERE player_id = p_remove;
  IF v_n > 0 THEN v_dropped := v_dropped || jsonb_build_object('session_attendance', v_n); END IF;

  UPDATE session_rsvp x SET player_id = p_keep
   WHERE x.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM session_rsvp k
                      WHERE k.player_id = p_keep AND k.session_id = x.session_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('session_rsvp', v_n); END IF;
  SELECT count(*) INTO v_n FROM session_rsvp WHERE player_id = p_remove;
  IF v_n > 0 THEN v_dropped := v_dropped || jsonb_build_object('session_rsvp', v_n); END IF;

  -- THE PAIR HALF OF THIS CONDITION IS NEW IN 00202, and it is the whole of
  -- codex round-10 defect 2. This rewrite asked only whether the survivor
  -- already had a PARTICIPANT row in the event, and tournament_pairs was never
  -- consulted. So: survivor is in a pair in event E, the removed account is
  -- loose in E's pool. The NOT EXISTS passes, the pool row is handed to the
  -- survivor, and one human is now simultaneously in the pair and in the pool
  -- of the same event -- two entry-cap slots, two places in the draw, from a
  -- merge with no concurrency of any kind. It is deterministic, and it is the
  -- original F-004 corruption reachable from a plain admin merge.
  --
  -- Dropping the pool row is the correct resolution and matches exactly what
  -- this statement already does when the survivor holds a participant row:
  -- the two accounts are one person, that person is already in the event via
  -- the pair, and the duplicate entry is the thing to discard. The count lands
  -- in v_dropped below like any other discard.
  --
  -- Withdrawn and disqualified pairs do not count, for the same reason they do
  -- not count in pair_tournament_entrants: an entry that has LEFT the event
  -- does not occupy it.
  UPDATE tournament_participants x SET player_id = p_keep
   WHERE x.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM tournament_participants k
                      WHERE k.player_id = p_keep AND k.event_id = x.event_id)
     AND NOT EXISTS (SELECT 1 FROM tournament_pairs pr
                      WHERE pr.event_id = x.event_id
                        AND pr.status NOT IN ('withdrawn', 'disqualified')
                        AND (pr.player1_id = p_keep OR pr.player2_id = p_keep));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('tournament_participants', v_n); END IF;
  SELECT count(*) INTO v_n FROM tournament_participants WHERE player_id = p_remove;
  IF v_n > 0 THEN v_dropped := v_dropped || jsonb_build_object('tournament_participants', v_n); END IF;

  -- tournament_matches holds FOUR NO ACTION references INTO tournament_participants
  -- (a, b, winner, loser). A discarded participant row — one whose event the
  -- survivor was already entered in — would leave those dangling, and the
  -- player DELETE then fails on the FK rather than cascading. This is the bug
  -- the old blanket guard was hiding: nothing downstream of the participant row
  -- was ever considered, because the merge never got this far.
  --
  -- Every reference is remapped to the survivor's row in the SAME event before
  -- the delete. tournament_matches has no unique constraint beyond its PK, so
  -- the remap cannot collide.
  -- THE EDGE THE PAIR GUARD OPENS -- 00202. The remap below sends a discarded
  -- participant row's matches to the survivor's row in the SAME event. When the
  -- survivor is in that event as a PAIR, they have no participant row, so there
  -- is nothing to remap to and the CASCADE delete would fail later on
  -- tournament_matches' NO ACTION reference -- an opaque foreign-key error at
  -- the very end of a long merge.
  --
  -- By construction this should be unreachable: participant_* columns are only
  -- filled for singles events and a pair only exists in a doubles event. That
  -- is an argument, not a check, and arguments of exactly this shape are what
  -- the last four review rounds kept breaking. So it is asked.
  IF EXISTS (
    SELECT 1
      FROM tournament_participants x
      JOIN tournament_matches tm
        ON tm.participant_a_id      = x.id OR tm.participant_b_id     = x.id
        OR tm.winner_participant_id = x.id OR tm.loser_participant_id = x.id
     WHERE x.player_id = p_remove
       AND NOT EXISTS (SELECT 1 FROM tournament_participants k
                        WHERE k.player_id = p_keep AND k.event_id = x.event_id)
  ) THEN
    RAISE EXCEPTION 'These accounts cannot be merged automatically: one of them has recorded draw matches in an event the other is entered in as part of a pair. Withdraw one of the two entries first, then merge.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  WITH remap AS (
    SELECT x.id AS old_id, k.id AS new_id
      FROM tournament_participants x
      JOIN tournament_participants k
        ON k.event_id = x.event_id AND k.player_id = p_keep
     WHERE x.player_id = p_remove
  )
  UPDATE tournament_matches tm SET
    participant_a_id      = COALESCE((SELECT new_id FROM remap WHERE old_id = tm.participant_a_id),      tm.participant_a_id),
    participant_b_id      = COALESCE((SELECT new_id FROM remap WHERE old_id = tm.participant_b_id),      tm.participant_b_id),
    winner_participant_id = COALESCE((SELECT new_id FROM remap WHERE old_id = tm.winner_participant_id), tm.winner_participant_id),
    loser_participant_id  = COALESCE((SELECT new_id FROM remap WHERE old_id = tm.loser_participant_id),  tm.loser_participant_id)
   WHERE tm.participant_a_id      IN (SELECT old_id FROM remap)
      OR tm.participant_b_id      IN (SELECT old_id FROM remap)
      OR tm.winner_participant_id IN (SELECT old_id FROM remap)
      OR tm.loser_participant_id  IN (SELECT old_id FROM remap);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('tournament_matches_remapped', v_n); END IF;

  -- The bracket equivalent of a self-play match: after the remap both sides of
  -- a draw match are the same participant. Same fiction, same treatment — named
  -- for a human, not silently corrected.
  SELECT array_agg(id) INTO v_tselfplay
    FROM tournament_matches
   WHERE participant_a_id IS NOT NULL AND participant_a_id = participant_b_id;

  -- Notes hang off the participant row with a CASCADE and a PK on participant_id,
  -- so they need the same treatment and cannot be moved onto a row that has one.
  UPDATE tournament_participant_notes n SET participant_id = k.id
    FROM tournament_participants x
    JOIN tournament_participants k
      ON k.event_id = x.event_id AND k.player_id = p_keep
   WHERE x.player_id = p_remove AND n.participant_id = x.id
     AND NOT EXISTS (SELECT 1 FROM tournament_participant_notes q WHERE q.participant_id = k.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('tournament_participant_notes', v_n); END IF;

  -- The event_feedback block stood here until 00176 dropped the table. 00175
  -- folded its rows into feedback_reports, and the feedback_reports block
  -- below carries them with the same tournament-scoped skip.

  -- feedback_reports now holds the tournament survey as well as bug reports, so
  -- this supersedes the event_feedback block above for everything written from
  -- 00175 on. Two shapes share the table and they merge differently:
  --   tournament_id IS NOT NULL  one row per (tournament, player), so the
  --                              survivor's own response wins and the loser's
  --                              duplicate stays behind -- the same rule the
  --                              event_feedback block applied.
  --   tournament_id IS NULL      a bug report or free-text feedback. Nothing is
  --                              unique about it, so all of them move.
  UPDATE feedback_reports x SET player_id = p_keep
   WHERE x.player_id = p_remove
     AND (x.tournament_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM feedback_reports k
                          WHERE k.player_id = p_keep
                            AND k.tournament_id = x.tournament_id));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('feedback_reports', v_n); END IF;
  -- What is left is a duplicate survey answer. The ON DELETE SET NULL on
  -- player_id turns it anonymous rather than deleting it, so the words survive
  -- even though the attribution does not.
  SELECT count(*) INTO v_n FROM feedback_reports WHERE player_id = p_remove;
  IF v_n > 0 THEN v_dropped := v_dropped || jsonb_build_object('feedback_reports', v_n); END IF;

  UPDATE legacy_tournament_participants x SET player_id = p_keep
   WHERE x.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM legacy_tournament_participants k
                      WHERE k.player_id = p_keep AND k.tournament_id = x.tournament_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('legacy_tournament_participants', v_n); END IF;
  SELECT count(*) INTO v_n FROM legacy_tournament_participants WHERE player_id = p_remove;
  IF v_n > 0 THEN v_dropped := v_dropped || jsonb_build_object('legacy_tournament_participants', v_n); END IF;

  -- season_final_ratings: the survivor's own row wins. That is the account that
  -- kept playing, so its archived rating is the one the ladder was built from.
  UPDATE season_final_ratings x SET player_id = p_keep
   WHERE x.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM season_final_ratings k
                      WHERE k.player_id = p_keep AND k.season_id = x.season_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('season_final_ratings', v_n); END IF;
  SELECT count(*) INTO v_n FROM season_final_ratings WHERE player_id = p_remove;
  IF v_n > 0 THEN v_dropped := v_dropped || jsonb_build_object('season_final_ratings', v_n); END IF;

  -- ---- Merge reliability metrics into the survivor (unchanged from 00079) ----
  UPDATE reliability_metrics k SET
    challenges_issued          = k.challenges_issued          + r.challenges_issued,
    challenges_accepted        = k.challenges_accepted        + r.challenges_accepted,
    challenges_rejected        = k.challenges_rejected        + r.challenges_rejected,
    challenges_expired         = k.challenges_expired         + r.challenges_expired,
    matches_completed          = k.matches_completed          + r.matches_completed,
    no_shows                   = k.no_shows                   + r.no_shows,
    walkover_flag              = k.walkover_flag OR r.walkover_flag,
    avg_confirmation_minutes   = CASE
      WHEN COALESCE(k.matches_completed,0) + COALESCE(r.matches_completed,0) = 0
        THEN k.avg_confirmation_minutes
      ELSE (COALESCE(k.avg_confirmation_minutes,0) * COALESCE(k.matches_completed,0)
          + COALESCE(r.avg_confirmation_minutes,0) * COALESCE(r.matches_completed,0))
         / (COALESCE(k.matches_completed,0) + COALESCE(r.matches_completed,0))
      END
    FROM reliability_metrics r
   WHERE k.player_id = p_keep AND r.player_id = p_remove;

  UPDATE reliability_metrics SET player_id = p_keep
   WHERE player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM reliability_metrics k WHERE k.player_id = p_keep);

  UPDATE ratings SET player_id = p_keep
   WHERE player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM ratings k WHERE k.player_id = p_keep);

  -- ---- Delete the loser, then adopt its login if the survivor had none ----
  DELETE FROM players WHERE id = p_remove;

  IF v_keep.user_id IS NULL AND v_remove.user_id IS NOT NULL THEN
    UPDATE players
       SET user_id = v_remove.user_id,
           onboarding_completed = (COALESCE(v_keep.onboarding_completed, FALSE)
                                   OR COALESCE(v_remove.onboarding_completed, FALSE))
     WHERE id = p_keep;
    v_moved_user := TRUE;
  END IF;

  -- ---- Re-derive the survivor's counters (00123) ----
  v_recomputed := public.recompute_player_stats(p_keep);
  IF v_recomputed > 0 THEN
    v_kept := v_kept || jsonb_build_object('stats_pairs_recomputed', v_recomputed);
  END IF;

  -- ---- Flag for review if the merge left anything a human should see ----
  IF COALESCE(array_length(v_selfplay, 1), 0) > 0
     OR COALESCE(array_length(v_tselfplay, 1), 0) > 0
     OR v_dropped <> '{}'::jsonb THEN
    v_review := jsonb_build_object(
      'state',            CASE WHEN COALESCE(array_length(v_selfplay,1),0) > 0
                                 OR COALESCE(array_length(v_tselfplay,1),0) > 0
                               THEN 'elo' ELSE 'discards' END,
      'at',               to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'merged_from',      p_remove,
      'merged_from_name', v_remove.full_name,
      'self_play_matches', COALESCE(to_jsonb(v_selfplay), '[]'::jsonb),
      'self_play_tournament_matches', COALESCE(to_jsonb(v_tselfplay), '[]'::jsonb),
      'discarded',        v_dropped
    );
    UPDATE players SET elo_review = v_review WHERE id = p_keep;
  END IF;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
  VALUES (
    p_actor, 'players_merged', 'player', p_keep,
    jsonb_build_object('removed_id', p_remove, 'removed_email', v_remove.email,
                       'removed_name', v_remove.full_name, 'removed_user_id', v_remove.user_id),
    jsonb_build_object('kept_id', p_keep, 'kept_email', v_keep.email,
                       'login_moved', v_moved_user, 'rows_retained', v_kept,
                       'rows_discarded', v_dropped, 'elo_review', v_review),
    'Duplicate account merged'
  );

  RETURN jsonb_build_object('kept_id', p_keep, 'removed_id', p_remove,
                            'login_moved', v_moved_user, 'rows_retained', v_kept,
                            'rows_discarded', v_dropped,
                            'elo_review', v_review,
                            'stats_pairs_recomputed', v_recomputed);
END;
$function$;

-- ---------------------------------------------------------------------
-- 3 + 4. swap / unpair: the read that happened before the lock
--        (round-10 defect 1)
-- ---------------------------------------------------------------------
--
-- Both functions read the pair, THEN took the advisory key derived from it,
-- and then never looked at the row again. 00201 gave them the right key at
-- the right time and it did not help, because the values every later
-- decision used had been read before the key was held.
--
-- The probe/re-read split below is the general shape for any fenced function
-- whose lock key is derived from the row it is about to write.
CREATE OR REPLACE FUNCTION public.swap_tournament_pair_member(p_pair_id uuid, p_outgoing_player_id uuid, p_incoming_player_id uuid, p_pair_name text, p_combined_elo integer, p_added_by uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pair    RECORD;
  v_event   RECORD;
  v_partner uuid;
  v_pooled  integer;
  v_out     integer;
  v_probe_event uuid;   -- 00202
  v_rows    integer;    -- 00202
BEGIN
  IF p_outgoing_player_id = p_incoming_player_id THEN
    RAISE EXCEPTION 'That player is already in this pair.' USING ERRCODE = 'check_violation';
  END IF;

  -- PROBE READ. Its ONLY output that may be used is event_id, to derive the
  -- advisory key; every other column is re-read under the lock below. See the
  -- block after the lock for why.
  SELECT event_id INTO v_probe_event
    FROM tournament_pairs
   WHERE id = p_pair_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pair not found.' USING ERRCODE = 'no_data_found';
  END IF;

  -- Serialise on the event, exactly as pairing does and for the same reason:
  -- "is the incoming player already on a team" is a read, and a read needs
  -- something to stop two desks from both passing it.
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_probe_event::text));

  -- THE RE-READ, UNDER THE LOCK — 00202, codex round-10 defect 1.
  --
  -- The read above is a PROBE and nothing more. It exists because the advisory
  -- key is derived from event_id and event_id lives on the pair, so the pair
  -- has to be read before the key can be taken -- and a read taken before the
  -- lock is a stale read no matter how correct the lock that follows it is.
  --
  -- What that cost, concretely: this function probed pair (A,B), and before it
  -- reached the key remove_field_entry took the same key, deleted the pair and
  -- committed. This function then acquired the key using its cached event id,
  -- deleted incoming player C's pool row, updated ZERO pair rows without
  -- noticing, and inserted outgoing player A back into the pool. Reported
  -- success. C had vanished from the event and B was gone with the pair.
  --
  -- So every decision below is made against v_pair as re-read here, holding
  -- both the key and a row lock. FOR UPDATE is what makes the row stay put for
  -- the rest of the transaction; the key alone does not freeze a row.
  SELECT id, event_id, player1_id, player2_id, status
    INTO v_pair
    FROM tournament_pairs
   WHERE id = p_pair_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This pair no longer exists — it was changed or removed while you were working. Reload the event and try again.'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- The event a pair belongs to is not something any code path rewrites, so
  -- this can only fire if one is added later. It is asked because the key was
  -- taken on the probe's answer: if the row moved events, the lock being held
  -- is the wrong one and nothing below is serialised at all.
  IF v_pair.event_id IS DISTINCT FROM v_probe_event THEN
    RAISE EXCEPTION 'This pair moved to a different event while you were working. Reload the event and try again.'
      USING ERRCODE = 'check_violation';
  END IF;


  IF p_outgoing_player_id NOT IN (v_pair.player1_id, v_pair.player2_id) THEN
    RAISE EXCEPTION 'That player is not in this pair.' USING ERRCODE = 'check_violation';
  END IF;

  v_partner := CASE WHEN v_pair.player1_id = p_outgoing_player_id
                    THEN v_pair.player2_id ELSE v_pair.player1_id END;
  IF p_incoming_player_id = v_partner THEN
    RAISE EXCEPTION 'A pair needs two different players.' USING ERRCODE = 'check_violation';
  END IF;

  IF v_pair.status IN ('withdrawn', 'disqualified') THEN
    RAISE EXCEPTION 'This pair has already left the event.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, status, draw_locked INTO v_event
    FROM tournament_events WHERE id = v_pair.event_id FOR UPDATE;  -- FOR UPDATE: 00201
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_event.draw_locked THEN
    RAISE EXCEPTION 'Draw is locked. Unlock it before making changes.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- THE EVENT STATUS, ASKED UNDER THE LOCK — 00201. The caller already refuses
  -- on exactly these two statuses before calling; this is the ask that the
  -- write actually lands against, which the caller's cannot be.
  --
  -- The in-any-match check below is NOT a substitute. It is the check that
  -- protects recorded results, and it only fires once match rows exist —
  -- leaving the window between a draw being published and its matches being
  -- written, which is precisely the window this migration exists to close.
  --
  -- AND A COUNT CANNOT SEE A SWAP: publish_event_draw's entrant_left check asks
  -- whether the pair ids it drew are still active, and a swap leaves the pair id
  -- alone. So the fence alone would serialise this against publication without
  -- publication noticing anything had changed. The status refusal is what
  -- actually closes it.
  IF v_event.status NOT IN ('registration', 'checkin') THEN
    RAISE EXCEPTION 'The draw for this event has already been generated, so its teams can no longer be changed. Regenerate the draw, or withdraw the pair.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- THE CHECK NO FOREIGN KEY WILL MAKE FOR US. See the header: this is an
  -- UPDATE, so nothing in the schema stops it rewriting a seeded team.
  IF EXISTS (
    SELECT 1 FROM tournament_matches
     WHERE pair_a_id = p_pair_id OR pair_b_id = p_pair_id
        OR winner_pair_id = p_pair_id OR loser_pair_id = p_pair_id
  ) THEN
    RAISE EXCEPTION 'This pair is already in the draw, so its players cannot be changed — their matches and ratings are recorded against the team as it stands. Regenerate the bracket, or withdraw the pair.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Already on another team in this event. Same rule pairing applies, and not
  -- expressible as an index: UNIQUE(event_id, player1_id, player2_id) is on the
  -- ordered triple.
  IF EXISTS (
    SELECT 1 FROM tournament_pairs
     WHERE event_id = v_pair.event_id
       AND id <> p_pair_id
       AND status NOT IN ('withdrawn', 'disqualified')
       AND (player1_id = p_incoming_player_id OR player2_id = p_incoming_player_id)
  ) THEN
    RAISE EXCEPTION 'That player is already in another pair in this event.'
      USING ERRCODE = 'unique_violation';
  END IF;

  -- THE INCOMING PLAYER'S POOL ROW. Required, and its absence is the refusal
  -- that keeps this function out of the entry business — see the header. The
  -- message names the step that makes it work.
  SELECT count(*) INTO v_pooled
    FROM tournament_participants
   WHERE event_id = v_pair.event_id
     AND player_id = p_incoming_player_id
     AND status NOT IN ('withdrawn', 'disqualified');
  IF v_pooled = 0 THEN
    SELECT count(*) INTO v_out
      FROM tournament_participants
     WHERE event_id = v_pair.event_id
       AND player_id = p_incoming_player_id;
    IF v_out > 0 THEN
      RAISE EXCEPTION 'That player has already left this event. Remove their withdrawn entry from the waiting list, add them again, then swap them in.'
        USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'That player has not entered this event. Add them to the waiting list first, then swap them in — that is what charges them and asks for the event waiver.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---- From here on, the two writes that have to happen together ----

  -- 1. The incoming player leaves the pool.
  DELETE FROM tournament_participants
   WHERE event_id = v_pair.event_id
     AND player_id = p_incoming_player_id;

  -- 2. The team changes hands. pair_name and combined_elo are RECOMPUTED by the
  --    caller and passed in — a swap that kept the old combined_elo would seed
  --    the draw off a player who is no longer in the team, and one that kept the
  --    old pair_name would put the wrong person's name on the bracket. Both are
  --    calculateTeamRating's and the caller's job for the reason 00070 gives.
  --
  --    The column written is chosen from which half is leaving, so the pair
  --    keeps its id, its seed_number and its created_at, and only its
  --    membership moves. seed_number is the identity that actually earns
  --    preservation: the exec seeded this team's position and swapping a player
  --    is not a reason to renumber the draw.
  --
  --    THE CHECK-IN IS RESET, and that is not incidental. 00102 creates a pair
  --    as 'registered' even when both halves had been checked in individually,
  --    because check-in is the gate that refuses an entrant with no current
  --    event-waiver acceptance and it is asked of the thing that takes the
  --    court. A swap on a CHECKED-IN pair carries that same hazard in its worst
  --    form: the team was screened with Priya in it, and keeping the status
  --    would leave Sam checked in — recorded as present at a desk he never
  --    visited, past a gate he never passed. The desk checks the new team in.
  UPDATE tournament_pairs
     SET player1_id = CASE WHEN player1_id = p_outgoing_player_id
                           THEN p_incoming_player_id ELSE player1_id END,
         player2_id = CASE WHEN player2_id = p_outgoing_player_id
                           THEN p_incoming_player_id ELSE player2_id END,
         pair_name = p_pair_name,
         combined_elo = p_combined_elo,
         status = 'registered',
         checked_in_at = NULL,
         checked_in_by = NULL
   WHERE id = p_pair_id;

  -- 00202. Belt to the FOR UPDATE's braces. An UPDATE that matches nothing is
  -- not an error in SQL, and this function's failure mode was reporting success
  -- after writing nothing at all. Holding a row lock on a row that was read in
  -- this transaction, this cannot fire -- which is the point: if it ever does,
  -- the re-read above has stopped being the thing it claims to be.
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'This pair changed while you were working (% rows updated). Reload the event and try again.', v_rows
      USING ERRCODE = 'no_data_found';
  END IF;

  -- 3. The outgoing player goes back to the pool — NOT out of the event. They
  --    entered, they paid, they signed and they hold one of their allowed
  --    entries; losing all three because somebody else took their place would
  --    punish them for an exec's decision. Same reasoning, and the same landing
  --    place, as the half-withdrawal in 00102. An exec who also wants them out
  --    withdraws them from the waiting list, visibly, as a second decision.
  INSERT INTO tournament_participants (event_id, player_id, status, elo_before, added_by)
  VALUES (
    v_pair.event_id,
    p_outgoing_player_id,
    'registered',
    COALESCE((SELECT r.doubles_elo FROM ratings r WHERE r.player_id = p_outgoing_player_id), 400),
    p_added_by
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.unpair_tournament_pair(p_pair_id uuid, p_withdrawn_player_id uuid, p_reason text, p_added_by uuid)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pair   RECORD;
  v_event  RECORD;
  v_ids    uuid[];
  v_probe_event uuid;   -- 00202
  v_rows   integer;     -- 00202
BEGIN
  -- PROBE READ. Its ONLY usable output is event_id, for the advisory key.
  SELECT event_id INTO v_probe_event
    FROM tournament_pairs
   WHERE id = p_pair_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pair not found.' USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_probe_event::text));

  -- THE RE-READ, UNDER THE LOCK — 00202, codex round-10 defect 1.
  --
  -- The read above is a PROBE and nothing more. It exists because the advisory
  -- key is derived from event_id and event_id lives on the pair, so the pair
  -- has to be read before the key can be taken -- and a read taken before the
  -- lock is a stale read no matter how correct the lock that follows it is.
  --
  -- What that cost, concretely: this function probed pair (A,B), and before it
  -- reached the key remove_field_entry took the same key, deleted the pair and
  -- committed. This function then acquired the key using its cached event id,
  -- deleted incoming player C's pool row, updated ZERO pair rows without
  -- noticing, and inserted outgoing player A back into the pool. Reported
  -- success. C had vanished from the event and B was gone with the pair.
  --
  -- So every decision below is made against v_pair as re-read here, holding
  -- both the key and a row lock. FOR UPDATE is what makes the row stay put for
  -- the rest of the transaction; the key alone does not freeze a row.
  SELECT id, event_id, player1_id, player2_id, status
    INTO v_pair
    FROM tournament_pairs
   WHERE id = p_pair_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This pair no longer exists — it was changed or removed while you were working. Reload the event and try again.'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- The event a pair belongs to is not something any code path rewrites, so
  -- this can only fire if one is added later. It is asked because the key was
  -- taken on the probe's answer: if the row moved events, the lock being held
  -- is the wrong one and nothing below is serialised at all.
  IF v_pair.event_id IS DISTINCT FROM v_probe_event THEN
    RAISE EXCEPTION 'This pair moved to a different event while you were working. Reload the event and try again.'
      USING ERRCODE = 'check_violation';
  END IF;


  IF p_withdrawn_player_id IS NOT NULL
     AND p_withdrawn_player_id NOT IN (v_pair.player1_id, v_pair.player2_id) THEN
    RAISE EXCEPTION 'That player is not in this pair.' USING ERRCODE = 'check_violation';
  END IF;

  -- A pair that has already left the event is not raw material for a pool
  -- entry: putting both halves back as 'registered' would quietly reverse a
  -- withdrawal that an exec, or a forfeit cascade, decided on.
  IF v_pair.status IN ('withdrawn', 'disqualified') THEN
    RAISE EXCEPTION 'This pair has already left the event.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, status, draw_locked INTO v_event
    FROM tournament_events WHERE id = v_pair.event_id FOR UPDATE;  -- FOR UPDATE: 00201
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_event.draw_locked THEN
    RAISE EXCEPTION 'Draw is locked. Unlock it before making changes.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- THE EVENT STATUS, ASKED UNDER THE LOCK — 00201. The caller already refuses
  -- on exactly these two statuses before calling; this is the ask that the
  -- write actually lands against, which the caller's cannot be.
  --
  -- The in-any-match check below is NOT a substitute. It is the check that
  -- protects recorded results, and it only fires once match rows exist —
  -- leaving the window between a draw being published and its matches being
  -- written, which is precisely the window this migration exists to close.
  --
  -- AND A COUNT CANNOT SEE A SWAP: publish_event_draw's entrant_left check asks
  -- whether the pair ids it drew are still active, and an unpair leaves the pair id
  -- alone. So the fence alone would serialise this against publication without
  -- publication noticing anything had changed. The status refusal is what
  -- actually closes it.
  IF v_event.status NOT IN ('registration', 'checkin') THEN
    RAISE EXCEPTION 'The draw for this event has already been generated, so its teams can no longer be changed. Regenerate the draw, or withdraw the pair.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The draw, checked as "is this pair in a match" rather than as an event
  -- status, because that is the thing the foreign keys actually protect.
  IF EXISTS (
    SELECT 1 FROM tournament_matches
     WHERE pair_a_id = p_pair_id OR pair_b_id = p_pair_id
        OR winner_pair_id = p_pair_id OR loser_pair_id = p_pair_id
  ) THEN
    RAISE EXCEPTION 'This pair is already in the draw, so it cannot be split up. Withdraw the pair instead, or regenerate the bracket.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  DELETE FROM tournament_pairs WHERE id = p_pair_id;

  -- 00202, same reasoning as the swap's row-count check: a DELETE that matches
  -- nothing is silent, and the two INSERTs below would then put both halves
  -- into the pool while somebody else's pair row still holds them.
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'This pair changed while you were working (% rows removed). Reload the event and try again.', v_rows
      USING ERRCODE = 'no_data_found';
  END IF;

  -- One statement for both halves. The status expression is what makes this
  -- function serve the withdrawal case as well as the plain unpair.
  --
  -- `notes` IS NO LONGER IN THIS COLUMN LIST — 00125. The withdrawal reason
  -- used to be written here, into a column of a table published by 00113, which
  -- put the exec's sentence on the wire to every bracket subscriber. It goes
  -- into tournament_participant_notes below instead.
  INSERT INTO tournament_participants (event_id, player_id, status, elo_before, added_by)
  SELECT
    v_pair.event_id,
    h.player_id,
    CASE WHEN h.player_id = p_withdrawn_player_id THEN 'withdrawn' ELSE 'registered' END,
    COALESCE((SELECT r.doubles_elo FROM ratings r WHERE r.player_id = h.player_id), 400),
    p_added_by
  FROM unnest(ARRAY[v_pair.player1_id, v_pair.player2_id]) AS h(player_id);

  -- Read back rather than RETURNING ... INTO, which keeps only the last row of
  -- a multi-row insert.
  SELECT array_agg(id) INTO v_ids
    FROM tournament_participants
   WHERE event_id = v_pair.event_id
     AND player_id IN (v_pair.player1_id, v_pair.player2_id);

  -- THE REASON, SOMEWHERE ONLY THE CONSOLE CAN READ IT — 00125.
  -- tournament_participant_notes holds no grant for anon or authenticated, has
  -- RLS on with no policy, and is not published; this function is SECURITY
  -- DEFINER and runs as the owner, so it can write there and nobody it writes
  -- about can read it back. Atomic with the withdrawal, which is better than
  -- the app-side note writes elsewhere: there is no state in which the entry is
  -- withdrawn and the reason went missing.
  --
  -- Only when there IS a reason: unpairEntry passes NULL and `note` is NOT NULL.
  IF p_withdrawn_player_id IS NOT NULL
     AND p_reason IS NOT NULL
     AND btrim(p_reason) <> '' THEN
    INSERT INTO tournament_participant_notes (participant_id, note, author_id)
    SELECT tp.id, p_reason, p_added_by
      FROM tournament_participants tp
     WHERE tp.event_id  = v_pair.event_id
       AND tp.player_id = p_withdrawn_player_id
    ON CONFLICT (participant_id) DO UPDATE
      SET note      = EXCLUDED.note,
          author_id = EXCLUDED.author_id;
  END IF;

  RETURN v_ids;
END;
$function$;

-- ---------------------------------------------------------------------
-- 5. set_field_entry_status: no_show had no prior-status guard
--    (round-10 defect 3)
-- ---------------------------------------------------------------------
--
-- The entry IS re-read under the lock here -- that part was already right --
-- but only 'checked_in' asked what the row was before. 'no_show' did not,
-- and no_show does NOT release an entry the way withdrawn and disqualified
-- do. So: A withdraws, the released slot is filled by B, and a desk screen
-- still showing A's old row marks A a no-show. A moves withdrawn -> no_show,
-- back into the counted field, and the event now counts both A and B.
--
-- 'no_show' is included in its own allowed set so a repeat press stays the
-- ordinary no-op the caller relies on, exactly as 'checked_in' does.
-- no_show -> checked_in is deliberately still refused; widening that is a
-- product decision, not this defect.
CREATE OR REPLACE FUNCTION public.set_field_entry_status(p_entry_id uuid, p_is_pair boolean, p_new_status text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event      uuid;
  v_tournament uuid;
  v_status     text;
  v_locked     boolean;
  v_before     text;
  v_already    boolean;
BEGIN
  IF p_new_status NOT IN ('checked_in', 'no_show', 'withdrawn', 'disqualified') THEN
    RAISE EXCEPTION 'set_field_entry_status: % is not a settable entry status', p_new_status;
  END IF;
  IF p_entry_id IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'set_field_entry_status: p_entry_id and p_is_pair may not be null';
  END IF;

  -- Unfenced, and only to learn which event to fence ON. Nothing is decided
  -- from this read; every value it produces is re-read below under the lock.
  IF p_is_pair THEN
    SELECT event_id INTO v_event FROM tournament_pairs WHERE id = p_entry_id;
  ELSE
    SELECT event_id INTO v_event FROM tournament_participants WHERE id = p_entry_id;
  END IF;
  IF v_event IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event::text));

  SELECT e.status::TEXT, e.tournament_id, e.draw_locked
    INTO v_status, v_tournament, v_locked
    FROM tournament_events e WHERE e.id = v_event FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- THE ENTRY, RE-READ UNDER THE LOCK. The row could have moved between the
  -- read above and this point; this is the value the write lands against.
  IF p_is_pair THEN
    SELECT status::TEXT INTO v_before FROM tournament_pairs
     WHERE id = p_entry_id AND event_id = v_event FOR UPDATE;
  ELSE
    SELECT status::TEXT INTO v_before FROM tournament_participants
     WHERE id = p_entry_id AND event_id = v_event FOR UPDATE;
  END IF;
  IF v_before IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;

  -- ---- the narrow status guards, per target status ----------------------
  IF p_new_status IN ('checked_in', 'no_show') THEN
    IF v_status = 'registration' THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                                'event_status', v_status);
    END IF;
  END IF;
  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_completed',
                              'event_status', v_status);
  END IF;

  -- Check-in is one of the two that moves a row FORWARD into play, so it cares
  -- what the row was: checking in somebody who has withdrawn would put them
  -- back in the field without anybody deciding to.
  IF p_new_status = 'checked_in' AND v_before NOT IN ('registered', 'checked_in') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_status',
                              'entry_status', v_before, 'event_status', v_status);
  END IF;

  -- AND SO IS no_show -- 00202. See the header above this function.
  IF p_new_status = 'no_show' AND v_before NOT IN ('registered', 'checked_in', 'no_show') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_status',
                              'entry_status', v_before, 'event_status', v_status);
  END IF;

  v_already := (v_before = p_new_status);

  -- A REPEAT PRESS WRITES NOTHING BUT IS NOT AN ERROR HERE. exitDrawImpl needs
  -- to distinguish "already withdrawn, nothing to do" from "already withdrawn,
  -- but the forfeit cascade stopped partway and this retry is what finishes
  -- it" — and only the caller knows which, because only it runs the cascade.
  IF NOT v_already THEN
    IF p_is_pair THEN
      UPDATE tournament_pairs
         SET status        = p_new_status,
             checked_in_at = CASE WHEN p_new_status = 'checked_in' THEN NOW() ELSE checked_in_at END,
             checked_in_by = CASE WHEN p_new_status = 'checked_in' THEN p_actor ELSE checked_in_by END
       WHERE id = p_entry_id;
    ELSE
      UPDATE tournament_participants
         SET status        = p_new_status,
             checked_in_at = CASE WHEN p_new_status = 'checked_in' THEN NOW() ELSE checked_in_at END,
             checked_in_by = CASE WHEN p_new_status = 'checked_in' THEN p_actor ELSE checked_in_by END
       WHERE id = p_entry_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'already', v_already,
    'entry_status_before', v_before,
    'event_status', v_status,
    'event_id', v_event,
    'tournament_id', v_tournament,
    'draw_locked', COALESCE(v_locked, FALSE)
  );
END;
$function$;

-- ---------------------------------------------------------------------
-- 8. mark_field_entries_no_show: ok:true on a partial match
--    (round-10 defect 8)
-- ---------------------------------------------------------------------
--
-- It counted the rows it updated into 'marked' and never compared that count
-- to the number of entries it was ASKED to mark. The caller ignores 'marked'
-- entirely, so a call that moved one of two entries reported the same success
-- as one that moved both -- and this function's whole purpose is marking BOTH
-- sides of a walkover together.
--
-- THE ELIGIBILITY CHECK RUNS BEFORE THE WRITE, NOT AFTER, and that ordering is
-- load-bearing rather than stylistic. A plpgsql RETURN is not a rollback: this
-- is reached over PostgREST, where the RPC call is the transaction, so a
-- refusal returned AFTER a partial UPDATE would commit that partial UPDATE and
-- report ok:false about it. Every pre-write refusal in this function is safe
-- for exactly that reason, and a post-write one would not be. The post-write
-- assertion below therefore RAISES -- the only thing that still rolls back.
--
-- The eligible set matches set_field_entry_status's no_show guard above, for
-- the same reason: no_show does not release an entry, so marking an entry that
-- has already left puts it back into the counted field.
CREATE OR REPLACE FUNCTION public.mark_field_entries_no_show(p_entry_ids uuid[], p_is_pair boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_events     uuid[];
  v_event      uuid;
  v_tournament uuid;
  v_status     text;
  v_marked     integer;
  v_requested  integer;   -- 00202
  v_eligible   integer;   -- 00202
BEGIN
  IF p_entry_ids IS NULL OR array_length(p_entry_ids, 1) IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'mark_field_entries_no_show: p_entry_ids may not be null or empty';
  END IF;

  -- DISTINCT, because the count this is compared against is a count of rows and
  -- the caller may legitimately pass the same id twice.
  SELECT count(*) INTO v_requested FROM (SELECT DISTINCT x FROM unnest(p_entry_ids) AS t(x)) d;

  IF p_is_pair THEN
    SELECT array_agg(DISTINCT event_id) INTO v_events
      FROM tournament_pairs WHERE id = ANY(p_entry_ids);
  ELSE
    SELECT array_agg(DISTINCT event_id) INTO v_events
      FROM tournament_participants WHERE id = ANY(p_entry_ids);
  END IF;

  IF v_events IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;
  IF array_length(v_events, 1) <> 1 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entries_span_events',
                              'events', array_length(v_events, 1));
  END IF;
  v_event := v_events[1];

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event::text));

  SELECT e.status::TEXT, e.tournament_id
    INTO v_status, v_tournament
    FROM tournament_events e WHERE e.id = v_event FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_status IN ('registration', 'completed') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                              'event_status', v_status);
  END IF;

  -- THE ROWS, LOCKED AND THEN COUNTED — 00202. Two statements because FOR
  -- UPDATE cannot ride along with an aggregate. Every writer of these rows is
  -- fenced on the key this transaction holds, so this is belt to those braces;
  -- an unfenced writer appearing later is the thing it actually guards against.
  IF p_is_pair THEN
    PERFORM 1 FROM tournament_pairs
      WHERE id = ANY(p_entry_ids) AND event_id = v_event FOR UPDATE;
    SELECT count(*) INTO v_eligible FROM tournament_pairs
      WHERE id = ANY(p_entry_ids) AND event_id = v_event
        AND status::TEXT IN ('registered', 'checked_in', 'no_show');
  ELSE
    PERFORM 1 FROM tournament_participants
      WHERE id = ANY(p_entry_ids) AND event_id = v_event FOR UPDATE;
    SELECT count(*) INTO v_eligible FROM tournament_participants
      WHERE id = ANY(p_entry_ids) AND event_id = v_event
        AND status::TEXT IN ('registered', 'checked_in', 'no_show');
  END IF;

  IF v_eligible <> v_requested THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entries_not_all_markable',
                              'requested', v_requested, 'eligible', v_eligible,
                              'event_id', v_event, 'event_status', v_status);
  END IF;

  IF p_is_pair THEN
    WITH done AS (
      UPDATE tournament_pairs SET status = 'no_show'
       WHERE id = ANY(p_entry_ids) AND event_id = v_event
         AND status::TEXT IN ('registered', 'checked_in', 'no_show')
      RETURNING id
    ) SELECT count(*) INTO v_marked FROM done;
  ELSE
    WITH done AS (
      UPDATE tournament_participants SET status = 'no_show'
       WHERE id = ANY(p_entry_ids) AND event_id = v_event
         AND status::TEXT IN ('registered', 'checked_in', 'no_show')
      RETURNING id
    ) SELECT count(*) INTO v_marked FROM done;
  END IF;

  -- RAISED, NOT RETURNED. See the header: past the write, a return commits.
  -- Holding the key and a row lock on every one of these rows, this cannot
  -- fire; if it ever does, one of those two things has stopped being true.
  IF v_marked <> v_requested THEN
    RAISE EXCEPTION 'mark_field_entries_no_show: asked to mark % entries, marked %', v_requested, v_marked
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'marked', v_marked, 'requested', v_requested,
                            'event_id', v_event, 'tournament_id', v_tournament,
                            'event_status', v_status);
END;
$function$;

-- ---------------------------------------------------------------------
-- 4 + 6. publish_event_draw: an id set cannot see a swap, and a
--        completed event could be overwritten (round-10 defects 4, 6;
--        and defect 5, which this dissolves rather than fixes)
-- ---------------------------------------------------------------------
--
-- DEFECT 4. The entrant_left check compares pair IDS. A swap keeps the pair
-- id, so it keeps the id set: publication could not see that the team it drew
-- now contains a different person, nor that combined_elo -- the number the
-- draw was seeded by -- had changed underneath it. 00201's status refusal in
-- swap_tournament_pair_member closes swap-after-publication; this closes
-- publication-after-swap, which is the other order and the one nothing saw.
--
-- WHY NOT A VERSION COUNTER ON THE EVENT. It was the obvious fix and it is
-- wrong. A check-in is a legitimate field write that CANNOT change the drawn
-- set -- registered and checked_in are both in the publication-active set, and
-- the entrant id does not move -- but a per-event counter cannot tell a
-- check-in from a swap, so it would bump and publication would refuse. Desks
-- check people in during exactly the window an exec presses Generate. That is
-- a routine false refusal shipped to fix a race, and it would only show up in
-- live use.
--
-- WHAT THIS DOES INSTEAD: it widens the comparison publication already makes,
-- from WHICH IDS to WHICH IDS AND WHAT THEY CONTAINED. p_digests is a jsonb
-- array positionally aligned with p_entrants, built by the generator FROM THE
-- VERY ROWS IT SNAPSHOTTED -- not re-read afterwards, which would reintroduce
-- the window this exists to close. Publication rebuilds the same object from
-- the live row under the lock and refuses on any difference.
--
-- THE DIGEST CARRIES RAW COLUMNS, NOT DERIVED VALUES. The generator coalesces
-- (combined_elo ?? 400) and picks between elo_after and elo_before depending on
-- which path built the field. Putting the derived number in the digest would
-- oblige this function to reproduce that choice, and a divergence between the
-- two implementations would be a silent false accept. So the digest carries
-- ce / eb / ea as they sit in the table and SQL compares columns to columns.
--
-- DEFECT 5 DISSOLVES HERE. Codex's fifth defect was that seed_number and
-- group_number are still written by direct unfenced PostgREST updates, so a
-- stored ordering could differ from the published fixtures invisibly. Those
-- two columns are in the digest, so publication now detects exactly that --
-- which is the same safety property fencing six call sites would have bought,
-- without a new RPC per write and without touching seeding.ts.
--
-- DEFECT 6. The function read the event status and used it only to test for
-- NULL and for the superseded check, then overwrote it unconditionally. A
-- finalization that committed 'completed' before this transaction took the key
-- would be read here as 'completed' and then replaced with a stale 'live'. Only
-- 'completed' is terminal among the seven statuses, and regeneration from any
-- of the other six is legitimate, so 'completed' is the whole refusal.
--
-- SIGNATURE CHANGE, AND WHY THE OLD ONE IS DROPPED RATHER THAN WRAPPED.
-- p_digests has no default. A wrapper keeping the 7-argument form would let a
-- caller that does not know about digests publish unchecked, which is the exact
-- failure this function's own header already records for the old nullable
-- p_expected: "null meant do not check, which is how the pool-seeded path came
-- to assert nothing". During a rolling deploy an old admin image now fails
-- loudly on a missing function instead of silently publishing unverified -- the
-- correct direction, and the reason the runbook's draw-generation drain step
-- exists.
DROP FUNCTION IF EXISTS public.publish_event_draw(uuid, text, boolean, uuid[], boolean, text, uuid);

CREATE OR REPLACE FUNCTION public.publish_event_draw(
  p_event_id uuid, p_new_status text, p_doubles boolean, p_entrants uuid[],
  p_whole_field boolean, p_phase text, p_generation uuid, p_digests jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status     TEXT;
  v_generation UUID;
  v_now        INTEGER;
  v_expected   INTEGER;
  v_left       INTEGER;
  v_extra      INTEGER;
  v_matches    INTEGER;
  v_foreign    INTEGER;
  v_changed    INTEGER;   -- 00202
  v_rows       INTEGER;   -- 00202
BEGIN
  IF p_new_status NOT IN ('bracket_generated', 'live', 'pool_generated', 'pool_live') THEN
    RAISE EXCEPTION 'publish_event_draw: % is not a draw-publication status', p_new_status;
  END IF;

  IF p_generation IS NULL THEN
    RAISE EXCEPTION 'publish_event_draw: p_generation may not be null';
  END IF;

  IF p_entrants IS NULL OR array_length(p_entrants, 1) IS NULL THEN
    RAISE EXCEPTION 'publish_event_draw: p_entrants may not be null or empty';
  END IF;
  IF p_whole_field IS NULL THEN
    RAISE EXCEPTION 'publish_event_draw: p_whole_field may not be null';
  END IF;

  v_expected := array_length(p_entrants, 1);

  -- RAISED, NOT REFUSED, and checked for SHAPE as well as presence — 00202. A
  -- misaligned array would compare entrant i against entrant j's digest and
  -- produce a refusal nobody could explain; a short one would leave the tail
  -- unchecked, which is the silent degradation this whole parameter exists to
  -- prevent.
  IF p_digests IS NULL OR jsonb_typeof(p_digests) <> 'array' THEN
    RAISE EXCEPTION 'publish_event_draw: p_digests must be a jsonb array';
  END IF;
  IF jsonb_array_length(p_digests) <> v_expected THEN
    RAISE EXCEPTION 'publish_event_draw: p_digests has % entries for % entrants',
      jsonb_array_length(p_digests), v_expected;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT e.status::TEXT, e.draw_generation_id
    INTO v_status, v_generation
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- 00202, defect 6. Read under the lock and now actually asked about.
  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_completed',
                              'event_status', v_status);
  END IF;

  IF v_generation IS DISTINCT FROM p_generation THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'superseded');
  END IF;

  -- ---- the drawn set, under the lock (00200) ---------------------------
  IF p_doubles THEN
    SELECT COUNT(*) INTO v_left
      FROM unnest(p_entrants) AS e(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM tournament_pairs pr
        WHERE pr.id = e.id AND pr.event_id = p_event_id
          AND pr.status::TEXT IN ('registered', 'checked_in'));
  ELSE
    SELECT COUNT(*) INTO v_left
      FROM unnest(p_entrants) AS e(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM tournament_participants tp
        WHERE tp.id = e.id AND tp.event_id = p_event_id
          AND tp.status::TEXT IN ('registered', 'checked_in'));
  END IF;

  IF v_left > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entrant_left', 'count', v_left);
  END IF;

  -- ---- WHAT THE ENTRANTS CONTAINED, under the same lock (00202) --------
  --
  -- Runs after entrant_left, so every id here is known to exist and to be
  -- active; the join cannot silently drop a row and read as "nothing changed".
  IF p_doubles THEN
    SELECT COUNT(*) INTO v_changed
      FROM unnest(p_entrants) WITH ORDINALITY AS e(id, ord)
      JOIN tournament_pairs pr ON pr.id = e.id AND pr.event_id = p_event_id
     WHERE jsonb_build_object(
             'p1',   pr.player1_id,
             'p2',   pr.player2_id,
             'ce',   pr.combined_elo,
             'seed', pr.seed_number,
             'grp',  pr.group_number)
           IS DISTINCT FROM (p_digests -> (e.ord - 1)::INTEGER);
  ELSE
    SELECT COUNT(*) INTO v_changed
      FROM unnest(p_entrants) WITH ORDINALITY AS e(id, ord)
      JOIN tournament_participants tp ON tp.id = e.id AND tp.event_id = p_event_id
     WHERE jsonb_build_object(
             'p',    tp.player_id,
             'eb',   tp.elo_before,
             'ea',   tp.elo_after,
             'seed', tp.seed_number,
             'grp',  tp.group_number)
           IS DISTINCT FROM (p_digests -> (e.ord - 1)::INTEGER);
  END IF;

  IF v_changed > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entrant_changed', 'count', v_changed);
  END IF;

  -- WHO IS IN THE EVENT BUT NOT IN THE DRAW.
  IF p_whole_field THEN
    IF p_doubles THEN
      SELECT COUNT(*) INTO v_now FROM tournament_pairs
       WHERE event_id = p_event_id AND status::TEXT IN ('registered', 'checked_in');
      SELECT COUNT(*) INTO v_extra FROM tournament_pairs
       WHERE event_id = p_event_id AND status::TEXT IN ('registered', 'checked_in')
         AND NOT (id = ANY (p_entrants));
    ELSE
      SELECT COUNT(*) INTO v_now FROM tournament_participants
       WHERE event_id = p_event_id AND status::TEXT IN ('registered', 'checked_in');
      SELECT COUNT(*) INTO v_extra FROM tournament_participants
       WHERE event_id = p_event_id AND status::TEXT IN ('registered', 'checked_in')
         AND NOT (id = ANY (p_entrants));
    END IF;

    IF v_extra > 0 THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'field_grew',
                                'expected', v_expected, 'now', v_now);
    END IF;
  END IF;

  -- WHAT WAS ACTUALLY BUILT (00197).
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE m.draw_generation_id IS DISTINCT FROM p_generation)
    INTO v_matches, v_foreign
    FROM tournament_matches m
   WHERE m.event_id = p_event_id
     AND (p_phase IS NULL OR m.phase = p_phase);

  IF v_foreign > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'foreign_matches', 'count', v_foreign);
  END IF;

  IF v_matches = 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_matches');
  END IF;

  -- COMPARE-AND-SET — 00202. The row has been held FOR UPDATE since it was
  -- read, so v_status cannot have moved and this cannot match zero rows. It is
  -- written as an assertion precisely because that argument depends on the
  -- FOR UPDATE above staying there: if a later edit drops it, this fails loudly
  -- instead of overwriting somebody else's status.
  UPDATE tournament_events
     SET status = p_new_status, updated_at = NOW()
   WHERE id = p_event_id
     AND status::TEXT = v_status;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'publish_event_draw: event status moved under the lock (% rows updated)', v_rows
      USING ERRCODE = 'serialization_failure';
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'matches', v_matches);
END;
$function$;

-- ---------------------------------------------------------------------
-- 9. promote_pool_qualifier: the target event was read unlocked
--     (codex round-10 secondary note)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.promote_pool_qualifier(p_event_id uuid, p_doubles boolean, p_player1_id uuid, p_player2_id uuid, p_pair_name text, p_elo integer, p_seed integer, p_admin_id uuid, p_checked_in_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id       uuid;
  v_conflict text;
  v_type     text;
  v_doubles  boolean;
  v_status   text;      -- 00202
BEGIN
  IF p_event_id IS NULL OR p_player1_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'bad_arguments');
  END IF;
  IF p_doubles AND p_player2_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'bad_arguments');
  END IF;
  -- A pair of one person. No constraint catches it; 00102 refuses it by hand
  -- and so does this.
  IF p_doubles AND p_player1_id = p_player2_id THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'same_player_twice');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  -- THE DISCIPLINE, off the event rather than off the argument. Read after the
  -- lock so it is the value the write will actually land against.
  --
  -- FOR UPDATE IS NEW IN 00202. The lock was taken and the event row was then
  -- read without one, so the row could still move: a finalization committing
  -- 'completed' between this read and the insert below left this function
  -- inserting a checked_in entrant into a finished event.
  SELECT e.event_type::TEXT, e.status::TEXT INTO v_type, v_status
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;
  IF v_type IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- ONLY 'completed', AND DELIBERATELY NOT A BLANKET PUBLISHED-STATUS REFUSAL
  -- -- 00202. Promotion into an event whose draw already exists is the normal
  -- case for a redraw, so refusing every generated or live status would break
  -- ordinary work. 'completed' is the one status from which no entrant should
  -- ever be added, and it is the one this defect was about.
  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_completed',
                              'event_status', v_status);
  END IF;
  v_doubles := v_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles');
  IF v_doubles IS DISTINCT FROM COALESCE(p_doubles, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'discipline_mismatch',
                              'event_type', v_type);
  END IF;

  -- Is either member ALREADY in this event's field by any route? Withdrawn and
  -- disqualified rows do not count, consistently with every other field count
  -- in 00196 and 00102. A pair row here means the caller's own `existing` map
  -- missed it, which is exactly the race this function exists to lose safely.
  SELECT CASE
           WHEN EXISTS (
             SELECT 1 FROM tournament_participants tp
              WHERE tp.event_id = p_event_id
                AND tp.player_id IN (p_player1_id, p_player2_id)
                AND COALESCE(tp.status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
           ) THEN 'participant'
           WHEN EXISTS (
             SELECT 1 FROM tournament_pairs pr
              WHERE pr.event_id = p_event_id
                AND (pr.player1_id IN (p_player1_id, p_player2_id)
                  OR pr.player2_id IN (p_player1_id, p_player2_id))
                AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
           ) THEN 'pair'
           ELSE NULL
         END
    INTO v_conflict;

  IF v_conflict IS NOT NULL THEN
    -- NOT counted as a skip. A withdrawal is a state the exec chose and the
    -- next finisher moving up is correct; this is a collision, and promoting
    -- around it would silently build a bracket that disagrees with the pool.
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_in_field',
                              'conflict', v_conflict);
  END IF;

  BEGIN
    IF p_doubles THEN
      INSERT INTO tournament_pairs
        (event_id, player1_id, player2_id, pair_name, combined_elo,
         status, checked_in_at, checked_in_by, seed_number, added_by)
      VALUES
        (p_event_id, p_player1_id, p_player2_id, p_pair_name, p_elo,
         'checked_in', p_checked_in_at, p_admin_id, p_seed, p_admin_id)
      RETURNING id INTO v_id;
    ELSE
      INSERT INTO tournament_participants
        (event_id, player_id, elo_before,
         status, checked_in_at, checked_in_by, seed_number, added_by)
      VALUES
        (p_event_id, p_player1_id, p_elo,
         'checked_in', p_checked_in_at, p_admin_id, p_seed, p_admin_id)
      RETURNING id INTO v_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    -- Belt and braces. The check above holds the lock, so reaching this means a
    -- constraint the check does not model, not the race it does.
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_in_field',
                              'conflict', 'unique_violation');
  END;

  RETURN jsonb_build_object('ok', TRUE, 'id', v_id);
END;
$function$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
--
-- DROP FUNCTION took publish_event_draw's grants with it, and a freshly
-- created function is EXECUTE-to-PUBLIC by default. Both halves are needed:
-- the REVOKE undoes the default, the GRANT restores what the old signature
-- actually had (service_role and nothing else). Every other function here was
-- CREATE OR REPLACE'd, which preserves grants.
REVOKE ALL ON FUNCTION public.publish_event_draw(uuid, text, boolean, uuid[], boolean, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_event_draw(uuid, text, boolean, uuid[], boolean, text, uuid, jsonb) TO service_role;

-- merge_players_disposable and merge_players_unhandled have been executable by
-- anon and authenticated since they were written. Nothing calls either from the
-- application -- their only caller is merge_players, which is SECURITY DEFINER
-- and runs as the owner, so grants do not gate it -- and what they return is a
-- list of table and column names. Small, but there is no reason for it to be
-- reachable, and this migration is already rewriting one of them.
REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;
REVOKE ALL ON FUNCTION public.merge_players_unhandled() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_unhandled() TO service_role;

-- THE REST OF THIS MIGRATION'S FUNCTIONS, STATED RATHER THAN ASSUMED.
-- CREATE OR REPLACE preserves grants, so every one of these already had exactly
-- these grants and none of the statements below change anything. They are
-- written out because a reader cannot tell "grants were preserved" from "grants
-- were forgotten" by looking at the file, and REVOKE ... FROM PUBLIC alone does
-- NOT drop Supabase's default anon grant -- the trap 00126 and 00187 record.
REVOKE ALL ON FUNCTION public.merge_players(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players(uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.swap_tournament_pair_member(uuid, uuid, uuid, text, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.swap_tournament_pair_member(uuid, uuid, uuid, text, integer, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.unpair_tournament_pair(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unpair_tournament_pair(uuid, uuid, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.set_field_entry_status(uuid, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_field_entry_status(uuid, boolean, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.mark_field_entries_no_show(uuid[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_field_entries_no_show(uuid[], boolean) TO service_role;
REVOKE ALL ON FUNCTION public.promote_pool_qualifier(uuid, boolean, uuid, uuid, text, integer, integer, uuid, timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_pool_qualifier(uuid, boolean, uuid, uuid, text, integer, integer, uuid, timestamp with time zone) TO service_role;

-- ---------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------
--
-- A CENSUS AND A POSITION, NOT A FRAGMENT GREP. Round 9's lesson was that
-- asserting "the body mentions the lock" proves nothing about whether the lock
-- is held when the decision is made -- codex pre-rejected exactly that shape.
-- So the two stale-read fixes are checked POSITIONALLY: the text before the
-- advisory-lock call must not contain any membership column or the record
-- variable every decision reads from. That is the defect itself, stated as an
-- assertion, and it fails if a later edit moves a read back above the lock.
DO $verify$
DECLARE
  v_bad  text[] := '{}';
  v_n    integer;
  v_body text;
  v_pos  integer;
  v_fu   integer;
  v_fn   text;
BEGIN
  -- 1. Every CASCADE player_id reference is classified. This is the check that
  --    catches the next 00194: a new foreign key that nobody classified makes
  --    merge_players raise on every call, and that refusal is invisible until
  --    somebody tries to merge.
  SELECT count(*) INTO v_n FROM merge_players_unhandled();
  IF v_n <> 0 THEN
    v_bad := array_append(v_bad, format('merge_players_unhandled() still returns %s row(s): %s',
      v_n, (SELECT string_agg(tbl || '.' || col, ', ') FROM merge_players_unhandled())));
  END IF;

  -- 2. The pair guard is actually in merge_players' participant rewrite.
  v_body := (SELECT prosrc FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace AND proname = 'merge_players');
  IF v_body IS NULL OR v_body NOT LIKE '%pr.player1_id = p_keep OR pr.player2_id = p_keep%' THEN
    v_bad := array_append(v_bad, 'merge_players does not consult tournament_pairs when rewriting participants');
  END IF;

  -- 3. THE POSITIONAL CHECK. For both stale-read functions: the advisory lock
  --    must exist, nothing before it may read membership or populate v_pair,
  --    and a FOR UPDATE re-read must follow it.
  FOREACH v_fn IN ARRAY ARRAY['swap_tournament_pair_member', 'unpair_tournament_pair'] LOOP
    v_body := (SELECT prosrc FROM pg_proc
                WHERE pronamespace = 'public'::regnamespace AND proname = v_fn);
    IF v_body IS NULL THEN
      v_bad := array_append(v_bad, v_fn || ' does not exist');
      CONTINUE;
    END IF;
    v_pos := strpos(v_body, 'pg_advisory_xact_lock');
    IF v_pos = 0 THEN
      v_bad := array_append(v_bad, v_fn || ' does not take the field key at all');
      CONTINUE;
    END IF;
    IF strpos(left(v_body, v_pos), 'INTO v_pair') > 0 THEN
      v_bad := array_append(v_bad, v_fn || ' still populates v_pair BEFORE taking the lock');
    END IF;
    IF strpos(left(v_body, v_pos), 'player1_id') > 0
       OR strpos(left(v_body, v_pos), 'player2_id') > 0 THEN
      v_bad := array_append(v_bad, v_fn || ' still reads pair membership BEFORE taking the lock');
    END IF;
    v_fu := strpos(v_body, 'FOR UPDATE');
    IF v_fu = 0 OR v_fu < v_pos THEN
      v_bad := array_append(v_bad, v_fn || ' has no FOR UPDATE re-read after the lock');
    END IF;
    IF strpos(v_body, 'GET DIAGNOSTICS v_rows = ROW_COUNT') = 0 THEN
      v_bad := array_append(v_bad, v_fn || ' does not check how many rows its write matched');
    END IF;
  END LOOP;

  -- 4. The old publication signature is gone and the new one is present. A
  --    surviving 7-argument form would let a caller publish unchecked.
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace AND proname = 'publish_event_draw'
                AND pronargs = 7) THEN
    v_bad := array_append(v_bad, 'the 7-argument publish_event_draw still exists');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace = 'public'::regnamespace AND proname = 'publish_event_draw'
                    AND pronargs = 8) THEN
    v_bad := array_append(v_bad, 'the 8-argument publish_event_draw was not created');
  END IF;

  -- 5. Its grants survived the drop, and the default PUBLIC grant did not.
  v_body := (SELECT COALESCE(array_to_string(proacl, ' | '), '(default: PUBLIC)')
               FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                AND proname = 'publish_event_draw' AND pronargs = 8);
  IF v_body IS NULL OR v_body NOT LIKE '%service_role=X%' THEN
    v_bad := array_append(v_bad, 'publish_event_draw is not executable by service_role: ' || COALESCE(v_body, 'null'));
  END IF;
  IF v_body LIKE '%(default: PUBLIC)%' OR v_body ~ '(^|\| )=X' THEN
    v_bad := array_append(v_bad, 'publish_event_draw is executable by PUBLIC: ' || v_body);
  END IF;

  -- 6. The three refusals this migration adds are reachable, named, and in the
  --    function that is supposed to make them.
  v_body := (SELECT prosrc FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace
                AND proname = 'publish_event_draw' AND pronargs = 8);
  IF v_body NOT LIKE '%entrant_changed%' THEN
    v_bad := array_append(v_bad, 'publish_event_draw cannot report entrant_changed');
  END IF;
  IF v_body NOT LIKE '%event_completed%' THEN
    v_bad := array_append(v_bad, 'publish_event_draw does not refuse a completed event');
  END IF;

  v_body := (SELECT prosrc FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace AND proname = 'set_field_entry_status');
  IF v_body NOT LIKE '%p_new_status = ''no_show'' AND v_before NOT IN%' THEN
    v_bad := array_append(v_bad, 'set_field_entry_status does not guard the prior status for no_show');
  END IF;

  v_body := (SELECT prosrc FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace AND proname = 'mark_field_entries_no_show');
  IF v_body NOT LIKE '%v_eligible <> v_requested%' OR v_body NOT LIKE '%v_marked <> v_requested%' THEN
    v_bad := array_append(v_bad, 'mark_field_entries_no_show does not compare what it marked to what it was asked');
  END IF;

  v_body := (SELECT prosrc FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace AND proname = 'promote_pool_qualifier');
  IF v_body NOT LIKE '%FOR UPDATE%' OR v_body NOT LIKE '%event_completed%' THEN
    v_bad := array_append(v_bad, 'promote_pool_qualifier does not lock its target event and refuse a completed one');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00202 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;

  RAISE NOTICE '00202: all round-10 defects verified closed.';
END;
$verify$;

-- publish_event_draw changed signature, so PostgREST's cached schema now names
-- a function that does not exist. Without this every generation 404s until the
-- cache happens to refresh.
NOTIFY pgrst, 'reload schema';

COMMIT;

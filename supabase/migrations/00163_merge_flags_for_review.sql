-- ============================================================
-- 00163 — a merge that finds a problem flags it instead of refusing
--
-- 00079 stopped where it stopped on purpose: "a loser with matches, money or
-- tournament history still refuses, because those are the cases with no safe
-- automatic answer." That was correct about the DATA and wrong about the
-- WORKFLOW. Refusing hands the admin an error string and no way forward — the
-- tool has never once been run in production, and the duplicate rows are still
-- sitting there. An admin who can see what is wrong can decide; an admin who
-- gets "Refusing to merge" cannot.
--
-- WHAT CHANGES: the blanket history guard is replaced by per-table handling.
-- Rows that can move, move. Rows that collide leave the survivor's copy in
-- place. Anything a human should look at is written to players.elo_review and
-- surfaced in the console. The merge now completes.
--
-- WHAT DOES NOT CHANGE: the two-login guard and the deletion_requested_at
-- guard both still refuse. Those have a correct answer that is not "flag it" —
-- one needs an auth identity moved first, the other is a promise to a member.
--
-- ---- THE THREE CLASSES ----
--
-- (1) NO UNIQUE KEY ON player_id — club_fees, varsity_notes, challenges.created_by,
--     disputes.opened_by, walkovers.forfeit_player_id. Nothing can collide, so
--     these simply move. They were never a real reason to refuse.
--
-- (2) UNIQUE (scope, player_id) — match_participants, challenge_participants,
--     session_attendance, session_rsvp, tournament_participants, event_feedback,
--     legacy_tournament_participants, season_final_ratings. Rows in a scope the
--     survivor is not already in move. Rows in a scope they ARE in cannot: the
--     survivor's row stays and the loser's cascades away with the delete. The
--     count of what was discarded goes into elo_review, because on this data
--     that discard is not always trivial — the two Cheng accounts entered the
--     same event and finished 1st and 2nd, so the discarded row is a real
--     result, not a duplicate of the kept one.
--
-- (3) DERIVED — head_to_head_stats, partnership_stats. Never repointed. They
--     are rebuilt by recompute_player_stats(p_keep) after the delete, which
--     00123 already wired up and which is why this migration does not name them.
--
-- ---- WHY ELO REVIEW IS A SEPARATE THING FROM A DISCARD ----
--
-- Two accounts belonging to one person can appear on OPPOSITE SIDES of the same
-- match. On this database they do: matches e1931dd0 and fbab74ef are both
-- Cheng-vs-Cheng, team_side a against b, with symmetric deltas (+72/-72 and
-- +51/-51). A person cannot beat themselves, so the rating those matches moved
-- is not a result — it is rating transferred between one person's two accounts,
-- and it is still sitting in the survivor's number after the merge.
--
-- The merge does NOT try to unwind that. Re-rating a match re-rates everyone
-- who played after it, and an automatic answer here would be a guess with
-- someone's ladder position attached. It records the match ids and flags the
-- survivor, which is the honest outcome: the merge is done, and a human is told
-- exactly which matches to look at.
--
-- ONE CONSEQUENCE TO BE CLEAR ABOUT: the loser's participant row in a self-play
-- match cascades away with the player delete, so such a match is left one
-- participant short. It is already invalid data — it records a person beating
-- themselves — and the alternatives are worse: deleting the match destroys the
-- other side's record in a doubles game, and re-rating it silently moves every
-- ladder position set after it. The flag names the match ids so an admin can
-- void or re-enter it deliberately.
--
-- elo_review mirrors privilege_claim_review (00132) deliberately — same column
-- type, same "written in SQL, parsed in TSX, total parse that never throws"
-- contract, so the console has one pattern for "this row needs a human" rather
-- than two.
-- ============================================================

BEGIN;

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS elo_review JSONB;

COMMENT ON COLUMN public.players.elo_review IS
  'Set by merge_players when a merge left something a human should check: '
  'self-play matches whose Elo is fictional, or participation rows discarded '
  'because the survivor was already in that scope. NULL means nothing to review. '
  'Cleared by the console once actioned. Shape is parsed by '
  'packages/shared/src/utils/elo-review.ts — keep the two in step.';

CREATE OR REPLACE FUNCTION public.merge_players(
  p_keep   UUID,
  p_remove UUID,
  p_actor  UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  UPDATE tournament_participants x SET player_id = p_keep
   WHERE x.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM tournament_participants k
                      WHERE k.player_id = p_keep AND k.event_id = x.event_id);
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

  UPDATE event_feedback x SET player_id = p_keep
   WHERE x.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM event_feedback k
                      WHERE k.player_id = p_keep AND k.tournament_id = x.tournament_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('event_feedback', v_n); END IF;
  SELECT count(*) INTO v_n FROM event_feedback WHERE player_id = p_remove;
  IF v_n > 0 THEN v_dropped := v_dropped || jsonb_build_object('event_feedback', v_n); END IF;

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

COMMIT;

NOTIFY pgrst, 'reload schema';

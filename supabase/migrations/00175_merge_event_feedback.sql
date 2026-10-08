-- One table for every piece of feedback, whatever it is and wherever it came in.
--
-- There were two stores: feedback_reports (00172), which already carries a kind
-- flag, a source flag and an id, and event_feedback (00001), the post-tournament
-- survey. This folds the second into the first so triage is one query instead of
-- two, and so the in-app form, the Discord commands and the survey all land in
-- the same place.
--
-- discord_feedback_posts is NOT part of this. Despite the name it holds no
-- feedback — it is the relay's map from a report to the Discord message it
-- became, and it is what makes an edit edit rather than repost.
--
-- event_feedback IS DELIBERATELY LEFT IN PLACE. Dropping it here would repeat
-- the club_ledger mistake: the tables went first, the code that read them was
-- live for two more days. The drop is a later migration, after this ships and
-- the code below is running.

-- ---------------------------------------------------------------------------
-- 1. The columns the survey needs.
-- ---------------------------------------------------------------------------
ALTER TABLE public.feedback_reports
  ADD COLUMN IF NOT EXISTS rating        smallint,
  -- CASCADE, unlike player_id's SET NULL. A report outlives its reporter
  -- because a bug is still a bug; feedback about a deleted event is about
  -- nothing at all, which is what event_feedback already did.
  ADD COLUMN IF NOT EXISTS tournament_id uuid REFERENCES public.tournaments(id) ON DELETE CASCADE;

DO $$ BEGIN
  ALTER TABLE public.feedback_reports
    ADD CONSTRAINT feedback_reports_rating_check CHECK (rating BETWEEN 1 AND 5);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. body has to become optional, because a survey can be a rating alone.
-- ---------------------------------------------------------------------------
--
-- 00172 made body NOT NULL because a Discord bug report with no words is
-- nothing. That stops being true once the survey lives here: its comment has
-- always been optional and a bare five stars is a real response. So body goes
-- nullable and the "must say something" rule moves to a check that either a
-- body or a rating is present — which still refuses a completely empty row.
ALTER TABLE public.feedback_reports ALTER COLUMN body DROP NOT NULL;

ALTER TABLE public.feedback_reports DROP CONSTRAINT IF EXISTS feedback_reports_body_check;
ALTER TABLE public.feedback_reports
  ADD CONSTRAINT feedback_reports_body_check
  CHECK (body IS NULL OR length(body) BETWEEN 1 AND 4000);

DO $$ BEGIN
  ALTER TABLE public.feedback_reports
    ADD CONSTRAINT feedback_reports_not_empty CHECK (body IS NOT NULL OR rating IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A tournament_id is exactly what makes a row survey feedback, in both
-- directions — so neither a survey response with no event nor a bug report
-- pinned to one can be written by accident.
DO $$ BEGIN
  ALTER TABLE public.feedback_reports
    ADD CONSTRAINT feedback_reports_tournament_kind
    CHECK ((kind = 'tournament_feedback') = (tournament_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 3. One response per player per event — and NOT a partial index.
-- ---------------------------------------------------------------------------
--
-- A partial unique index (WHERE kind = 'tournament_feedback') is the obvious
-- shape and it does not work: Postgres can only infer a partial index when the
-- statement repeats its predicate, and PostgREST's upsert cannot emit that. A
-- plain unique index does the job anyway, because unique indexes treat NULLs as
-- distinct — every bug report has a NULL tournament_id, so any number of them
-- coexist, while two survey responses to the same event collide as intended.
CREATE UNIQUE INDEX IF NOT EXISTS feedback_reports_tournament_player_key
  ON public.feedback_reports (tournament_id, player_id);

-- ---------------------------------------------------------------------------
-- 4. Move the rows.
-- ---------------------------------------------------------------------------
--
-- source='app': the survey has only ever been a form in the player app. The
-- guard is ON CONFLICT rather than a WHERE, so re-running this migration cannot
-- duplicate a response.
INSERT INTO public.feedback_reports
  (kind, body, rating, tournament_id, player_id, source, created_at, updated_at)
SELECT 'tournament_feedback',
       NULLIF(btrim(f.comment), ''),
       f.rating,
       f.tournament_id,
       f.player_id,
       'app',
       f.created_at,
       f.updated_at
  FROM public.event_feedback f
 WHERE f.rating IS NOT NULL OR NULLIF(btrim(f.comment), '') IS NOT NULL
ON CONFLICT (tournament_id, player_id) DO NOTHING;
-- ---------------------------------------------------------------------------
-- 5. merge_players has to move these too.
-- ---------------------------------------------------------------------------
--
-- 00163 moves event_feedback rows when two accounts merge, skipping any event
-- the survivor already answered. 00172 deliberately did NOT add feedback_reports
-- to that function -- "not worth rewriting history for prose nothing reads yet".
--
-- That reasoning expires here, and not as a nice-to-have. Folding the survey
-- into this table WITHOUT this block would be a REGRESSION: survey responses
-- are carried across a merge today, and afterwards they would silently go
-- anonymous instead. The unhandled-reference guard at the top of the function
-- cannot catch it either -- that guard only enumerates CASCADE references, and
-- feedback_reports.player_id is ON DELETE SET NULL, so a merge would drop the
-- attribution quietly and report success.
--
-- The whole function is restated because a plpgsql body cannot be patched in
-- place. Everything below is 00163's definition verbatim; the only change is
-- the feedback_reports block, which sits directly after the event_feedback one
-- it supersedes.
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

-- ---------------------------------------------------------------------------
-- 6. Classify player_discord_links so the merge guard stops refusing.
-- ---------------------------------------------------------------------------
--
-- See the block inside merge_players above. This is the half that silences the
-- guard; that one is the half that actually moves the row. Both are needed --
-- classifying without repointing would turn a loud refusal into silent data
-- loss, which is strictly worse.
CREATE OR REPLACE FUNCTION public.merge_players_unhandled()
 RETURNS TABLE(tbl text, col text)
 LANGUAGE sql
 STABLE
AS $unhandled$
  SELECT c.conrelid::regclass::text, a.attname::text
  FROM pg_constraint c
  JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ord) ON TRUE
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
  WHERE c.contype = 'f'
    AND c.confrelid = 'public.players'::regclass
    AND c.confdeltype = 'c'
    AND (c.conrelid::regclass::text, a.attname::text) NOT IN (
      SELECT tbl, col FROM merge_players_disposable()
      UNION ALL
      -- Blocked by the guard: the loser provably has none of these.
      -- season_snapshots was listed here until 00162 dropped it.
      SELECT * FROM (VALUES
        ('challenge_participants','player_id'), ('challenges','created_by'),
        ('club_fees','player_id'), ('disputes','opened_by'),
        ('event_feedback','player_id'), ('head_to_head_stats','player_a_id'),
        ('head_to_head_stats','player_b_id'), ('legacy_tournament_participants','player_id'),
        ('match_participants','player_id'), ('partnership_stats','player_a_id'),
        ('partnership_stats','player_b_id'), ('reinstatement_fees','player_id'),
        ('season_final_ratings','player_id'),
        ('session_attendance','player_id'), ('session_rsvp','player_id'),
        ('tournament_fees','player_id'), ('tournament_participants','player_id'),
        ('varsity_notes','player_id'), ('varsity_notes','author_id'),
        ('walkovers','forfeit_player_id'), ('walkovers','reported_by')
      ) AS blocked(tbl, col)
      UNION ALL
      -- Repointed below, so the rows survive the merge.
      SELECT * FROM (VALUES
        ('waiver_acceptances','player_id'), ('event_waiver_acceptances','player_id'),
        ('announcement_reads','player_id'), ('passkey_credentials','player_id'),
        ('player_discord_links','player_id')
      ) AS kept(tbl, col)
    );
$unhandled$;

COMMENT ON COLUMN public.feedback_reports.rating IS
  'Post-event survey rating, 1-5. NULL for every other kind.';
COMMENT ON COLUMN public.feedback_reports.tournament_id IS
  'Set exactly when kind = tournament_feedback; enforced by feedback_reports_tournament_kind.';

NOTIFY pgrst, 'reload schema';

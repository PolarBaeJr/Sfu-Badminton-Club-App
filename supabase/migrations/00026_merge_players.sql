-- ============================================================
-- 00026_merge_players.sql — admin tool to merge duplicate player accounts
-- ============================================================
-- The recurring case: an admin pre-adds someone to the roster under their SFU
-- email, then that person signs up themselves with a personal email. Two player
-- rows, one with the history, one with the login.
--
-- You cannot give two rows the same UUID — `id` is the primary key. A "merge"
-- means: pick a survivor, repoint every reference off the loser, delete it.
--
-- Design notes (why this is written the way it is):
--
-- * 56 FK columns reference players. They partition by ON DELETE rule:
--     - CASCADE (31 cols) — rows die with the loser. Safe ONLY because the
--       guard below proves the loser has no history worth keeping.
--     - NO ACTION (13) — the DELETE would THROW unless repointed.
--     - SET NULL (12) — the DELETE would silently null out attribution
--       ("who submitted this match" becomes unknown, forever), so repoint too.
--   The 25 NO ACTION + SET NULL columns are listed explicitly below rather than
--   looped over pg_constraint dynamically: a table added later must not silently
--   join a destructive operation without review.
--
-- * The guard refuses any merge where the LOSER has real history — competitive
--   records, money, or tournament involvement. That single precondition removes
--   every genuinely hard case: no two ELOs to reconcile, no
--   head_to_head/partnership rows that would collapse to player_a = player_b,
--   and no UNIQUE(x, player_id) collisions to resolve. Anything richer than the
--   roster-vs-signup case fails loudly instead of silently corrupting ratings.
--   `ratings` and `reliability_metrics` are deliberately NOT in the guard: every
--   player is auto-provisioned one, so including them would block every merge.
--
-- * Auth: if BOTH rows have a user_id we refuse. Deleting a player row leaves
--   its auth.users identity intact, and that orphan would hit /onboarding on
--   next login and create a THIRD player row — the tool would manufacture the
--   duplicates it exists to remove. When only the loser has a login we move it
--   to the survivor, so no orphan is ever created.
-- ============================================================

-- Tables whose rows represent history we refuse to destroy. Kept as one list so
-- the preview and the guard can never drift apart.
CREATE OR REPLACE FUNCTION merge_players_preview(p_keep UUID, p_remove UUID)
RETURNS TABLE (table_name TEXT, row_count BIGINT, effect TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT t.tbl, t.n, CASE WHEN t.n > 0 THEN 'BLOCKS MERGE' ELSE 'ok' END
  FROM (
    SELECT 'match_participants'::TEXT AS tbl, count(*) AS n FROM match_participants WHERE player_id = p_remove
    UNION ALL SELECT 'challenge_participants', count(*) FROM challenge_participants WHERE player_id = p_remove
    UNION ALL SELECT 'challenges (created)',   count(*) FROM challenges WHERE created_by = p_remove
    UNION ALL SELECT 'session_attendance',     count(*) FROM session_attendance WHERE player_id = p_remove
    UNION ALL SELECT 'session_rsvp',           count(*) FROM session_rsvp WHERE player_id = p_remove
    UNION ALL SELECT 'tournament_participants',count(*) FROM tournament_participants WHERE player_id = p_remove
    UNION ALL SELECT 'tournament_pairs',       count(*) FROM tournament_pairs WHERE player1_id = p_remove OR player2_id = p_remove
    UNION ALL SELECT 'tournament_fees',        count(*) FROM tournament_fees WHERE player_id = p_remove
    UNION ALL SELECT 'club_fees',              count(*) FROM club_fees WHERE player_id = p_remove
    UNION ALL SELECT 'reinstatement_fees',     count(*) FROM reinstatement_fees WHERE player_id = p_remove
    UNION ALL SELECT 'head_to_head_stats',     count(*) FROM head_to_head_stats WHERE player_a_id = p_remove OR player_b_id = p_remove
    UNION ALL SELECT 'partnership_stats',      count(*) FROM partnership_stats WHERE player_a_id = p_remove OR player_b_id = p_remove
    UNION ALL SELECT 'season_snapshots',       count(*) FROM season_snapshots WHERE player_id = p_remove
    UNION ALL SELECT 'season_final_ratings',   count(*) FROM season_final_ratings WHERE player_id = p_remove
    UNION ALL SELECT 'disputes (opened)',      count(*) FROM disputes WHERE opened_by = p_remove
    UNION ALL SELECT 'walkovers',              count(*) FROM walkovers WHERE forfeit_player_id = p_remove OR reported_by = p_remove
    UNION ALL SELECT 'event_feedback',         count(*) FROM event_feedback WHERE player_id = p_remove
    UNION ALL SELECT 'varsity_notes',          count(*) FROM varsity_notes WHERE player_id = p_remove OR author_id = p_remove
    UNION ALL SELECT 'legacy_tournament_participants', count(*) FROM legacy_tournament_participants WHERE player_id = p_remove OR partner_id = p_remove
  ) t
  ORDER BY t.n DESC, t.tbl;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION merge_players_preview(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION merge_players_preview(UUID, UUID) TO service_role;


CREATE OR REPLACE FUNCTION merge_players(p_keep UUID, p_remove UUID, p_actor UUID)
RETURNS JSONB AS $$
DECLARE
  v_blocking   TEXT;
  v_keep       players%ROWTYPE;
  v_remove     players%ROWTYPE;
  v_moved_user BOOLEAN := FALSE;
BEGIN
  IF p_keep = p_remove THEN
    RAISE EXCEPTION 'Cannot merge a player into themselves';
  END IF;

  SELECT * INTO v_keep   FROM players WHERE id = p_keep;
  SELECT * INTO v_remove FROM players WHERE id = p_remove;
  IF v_keep.id IS NULL  THEN RAISE EXCEPTION 'Surviving player % not found', p_keep; END IF;
  IF v_remove.id IS NULL THEN RAISE EXCEPTION 'Player to remove % not found', p_remove; END IF;

  -- Guard: refuse if the removed account carries real history.
  SELECT string_agg(format('%s (%s)', table_name, row_count), ', ')
    INTO v_blocking
    FROM merge_players_preview(p_keep, p_remove)
   WHERE row_count > 0;

  IF v_blocking IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to merge: the account being removed has history — %. Merge the other direction, or clear these first.',
      v_blocking;
  END IF;

  -- Guard: two logins cannot be merged (see header — orphaned auth.users would
  -- re-onboard into a third player row).
  IF v_keep.user_id IS NOT NULL AND v_remove.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'Both accounts have a login. Delete one auth user first, then merge.';
  END IF;

  -- ---- Repoint NO ACTION columns (DELETE would otherwise throw) ----
  UPDATE players                SET banned_by         = p_keep WHERE banned_by         = p_remove;
  UPDATE announcements          SET author_id         = p_keep WHERE author_id         = p_remove;
  UPDATE club_fees              SET marked_by         = p_keep WHERE marked_by         = p_remove;
  UPDATE reinstatement_fees     SET marked_by         = p_keep WHERE marked_by         = p_remove;
  UPDATE tournament_fees        SET marked_by         = p_keep WHERE marked_by         = p_remove;
  UPDATE tournament_audit_log   SET performed_by      = p_keep WHERE performed_by      = p_remove;
  UPDATE tournament_matches     SET result_entered_by = p_keep WHERE result_entered_by = p_remove;
  UPDATE tournament_pairs       SET added_by          = p_keep WHERE added_by          = p_remove;
  UPDATE tournament_pairs       SET checked_in_by     = p_keep WHERE checked_in_by     = p_remove;
  UPDATE tournament_participants SET added_by         = p_keep WHERE added_by          = p_remove;
  UPDATE tournament_participants SET checked_in_by    = p_keep WHERE checked_in_by     = p_remove;
  -- tournament_pairs.player1_id/player2_id are NO ACTION too, but the guard
  -- proved there are none for the removed player.

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

  -- ---- Delete the loser, then adopt its login if the survivor had none ----
  -- Order matters: players.user_id and players.email are UNIQUE, so the row must
  -- be gone before the survivor can take its values.
  DELETE FROM players WHERE id = p_remove;

  -- The SURVIVOR's own fields always win — name, email, status, everything the
  -- admin entered on the roster record is preserved. We adopt only the login
  -- link (user_id), never the self-signup's name or email, so a member typing
  -- "Steven" at signup can't overwrite the admin's "Steven Sun" / SFU email.
  -- Auth identity lives in auth.users, so sign-in keeps working with whatever
  -- address they actually log in with, regardless of players.email.
  IF v_keep.user_id IS NULL AND v_remove.user_id IS NOT NULL THEN
    UPDATE players
       SET user_id = v_remove.user_id,
           onboarding_completed = TRUE
     WHERE id = p_keep;
    v_moved_user := TRUE;
  END IF;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
  VALUES (
    p_actor, 'players_merged', 'player', p_keep,
    jsonb_build_object('removed_id', p_remove, 'removed_email', v_remove.email,
                       'removed_name', v_remove.full_name, 'removed_user_id', v_remove.user_id),
    jsonb_build_object('kept_id', p_keep, 'kept_email', v_keep.email, 'login_moved', v_moved_user),
    'Duplicate account merged'
  );

  RETURN jsonb_build_object('kept_id', p_keep, 'removed_id', p_remove, 'login_moved', v_moved_user);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Admin-only: the admin app calls this with the service-role key.
REVOKE ALL ON FUNCTION merge_players(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION merge_players(UUID, UUID, UUID) TO service_role;

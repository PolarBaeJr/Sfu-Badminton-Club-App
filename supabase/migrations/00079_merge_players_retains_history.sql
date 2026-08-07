-- ============================================================
-- 00079 — merge_players keeps what it can instead of deleting it
--
-- 00026 partitioned the 56 FK columns by ON DELETE rule and repointed the 25
-- that are NO ACTION or SET NULL. The 31 CASCADE columns were left to die with
-- the loser, which was safe because the guard refuses any merge where the loser
-- has real history.
--
-- Safe, but lossy. In the case the tool exists for — an admin pre-adds someone,
-- that person then signs up themselves — the duplicate's only assets ARE
-- CASCADE rows: their login, their passkey, their signed waiver, their push
-- subscription. The merge threw away exactly the things the duplicate had.
--
-- WHAT CHANGES: CASCADE rows that represent something worth keeping are now
-- repointed to the survivor before the delete, and reliability_metrics is
-- merged rather than dropped. What the guard blocks is unchanged — a loser with
-- matches, money or tournament history still refuses, because those are the
-- cases with no safe automatic answer.
--
-- WHY NOT "KEEP THE HIGHER RATING": min_elo is 100, so a player who has been
-- losing sits below the 400 default. Merging their empty duplicate in under a
-- "keep the higher" rule would award them the duplicate's untouched 400 — free
-- Elo for having signed up twice, silently, to the players least likely to
-- notice. The rule is "keep the row that has played", which agrees with "keep
-- the higher" whenever the survivor is above 400 and is right when they are not.
--
-- RELIABILITY METRICS are counters, so they sum. Two exceptions:
--   * avg_confirmation_minutes is an average — averaging two averages weights a
--     2-match sample the same as a 20-match one. Weighted by matches_completed.
--   * walkover_flag is OR, never MAX-of-sum. If it were dropped or averaged
--     away, merging would become a way to launder a walkover flag off an
--     account.
-- Both collapse to "the survivor's value" while the guard forbids a loser with
-- matches — they are written for correctness if that guard ever widens.
--
-- COMPLETENESS: a new table with a CASCADE FK to players used to join a
-- destructive operation silently. 00026 chose an explicit list over looping
-- pg_constraint so that could not happen without review — but nothing enforced
-- the review, and three tables (waiver_acceptances, event_waiver_acceptances,
-- announcement_reads) were already being dropped unnoticed. merge_players now
-- asserts at run time that every CASCADE column is either blocked, repointed,
-- or explicitly declared disposable, and refuses to run if one is unaccounted
-- for. The list stays explicit; the catalog just checks the list is complete.
-- ============================================================

-- Columns whose rows are genuinely worthless once the account is gone: a device
-- push token, a personal calendar URL, an unread notification. Declared rather
-- than assumed, so the completeness check below has something to compare to.
CREATE OR REPLACE FUNCTION merge_players_disposable()
RETURNS TABLE (tbl TEXT, col TEXT)
LANGUAGE sql IMMUTABLE AS $$
  SELECT * FROM (VALUES
    ('notifications',        'player_id'),   -- per-account delivery log
    ('push_subscriptions',   'player_id'),   -- device tokens, re-registered on next login
    ('calendar_feed_tokens', 'player_id'),   -- PK is player_id; survivor keeps theirs
    ('ratings',              'player_id'),   -- untouched base row; see header
    ('reliability_metrics',  'player_id')    -- merged into the survivor's, then dropped
  ) AS t(tbl, col);
$$;

-- Fails loudly if the schema grows a CASCADE column nobody has classified.
CREATE OR REPLACE FUNCTION merge_players_unhandled()
RETURNS TABLE (tbl TEXT, col TEXT)
LANGUAGE sql STABLE AS $$
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
      SELECT * FROM (VALUES
        ('challenge_participants','player_id'), ('challenges','created_by'),
        ('club_fees','player_id'), ('disputes','opened_by'),
        ('event_feedback','player_id'), ('head_to_head_stats','player_a_id'),
        ('head_to_head_stats','player_b_id'), ('legacy_tournament_participants','player_id'),
        ('match_participants','player_id'), ('partnership_stats','player_a_id'),
        ('partnership_stats','player_b_id'), ('reinstatement_fees','player_id'),
        ('season_final_ratings','player_id'), ('season_snapshots','player_id'),
        ('session_attendance','player_id'), ('session_rsvp','player_id'),
        ('tournament_fees','player_id'), ('tournament_participants','player_id'),
        ('varsity_notes','player_id'), ('varsity_notes','author_id'),
        ('walkovers','forfeit_player_id'), ('walkovers','reported_by')
      ) AS blocked(tbl, col)
      UNION ALL
      -- Repointed below, so the rows survive the merge.
      SELECT * FROM (VALUES
        ('waiver_acceptances','player_id'), ('event_waiver_acceptances','player_id'),
        ('announcement_reads','player_id'), ('passkey_credentials','player_id')
      ) AS kept(tbl, col)
    );
$$;

CREATE OR REPLACE FUNCTION public.merge_players(p_keep uuid, p_remove uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_blocking   TEXT;
  v_unhandled  TEXT;
  v_keep       players%ROWTYPE;
  v_remove     players%ROWTYPE;
  v_moved_user BOOLEAN := FALSE;
  v_kept       JSONB   := '{}'::jsonb;
  v_n          BIGINT;
BEGIN
  IF p_keep = p_remove THEN
    RAISE EXCEPTION 'Cannot merge a player into themselves';
  END IF;

  SELECT * INTO v_keep   FROM players WHERE id = p_keep;
  SELECT * INTO v_remove FROM players WHERE id = p_remove;
  IF v_keep.id IS NULL  THEN RAISE EXCEPTION 'Surviving player % not found', p_keep; END IF;
  IF v_remove.id IS NULL THEN RAISE EXCEPTION 'Player to remove % not found', p_remove; END IF;

  -- Guard: a CASCADE column nobody has classified would be deleted silently.
  SELECT string_agg(format('%s.%s', tbl, col), ', ') INTO v_unhandled
    FROM merge_players_unhandled();
  IF v_unhandled IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to merge: % has a CASCADE reference to players that merge_players does not handle. Classify it in 00079 (blocked, repointed, or disposable) before merging.',
      v_unhandled;
  END IF;

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

  -- ---- NEW: repoint CASCADE rows worth keeping ----
  -- Each is guarded by NOT EXISTS on its unique key, so a row the survivor
  -- already has wins and the loser's duplicate is left to cascade away. A plain
  -- UPDATE would raise a unique violation and abort the whole merge.

  -- Signed waivers. The reason this matters most: consent is the one thing a
  -- self-signup duplicate definitely has, and losing it silently makes a member
  -- who did accept look like they never did.
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

  -- A passkey is a real credential the member enrolled; making them re-enrol
  -- after an admin merges their duplicate is a support ticket.
  UPDATE passkey_credentials SET player_id = p_keep WHERE player_id = p_remove;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('passkey_credentials', v_n); END IF;

  UPDATE announcement_reads a SET player_id = p_keep
   WHERE a.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM announcement_reads k
                      WHERE k.player_id = p_keep AND k.announcement_id = a.announcement_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('announcement_reads', v_n); END IF;

  -- ---- NEW: merge reliability metrics into the survivor ----
  -- Counters sum. avg_confirmation_minutes is weighted by matches_completed,
  -- because averaging two averages weights a 2-match sample like a 20-match one.
  -- walkover_flag is OR: merging must not be a way to clear a flag.
  UPDATE reliability_metrics k SET
    challenges_issued          = k.challenges_issued          + r.challenges_issued,
    challenges_accepted        = k.challenges_accepted        + r.challenges_accepted,
    challenges_rejected        = k.challenges_rejected        + r.challenges_rejected,
    challenges_expired         = k.challenges_expired         + r.challenges_expired,
    matches_completed          = k.matches_completed          + r.matches_completed,
    no_shows                   = k.no_shows                   + r.no_shows,
    late_cancellations         = k.late_cancellations         + r.late_cancellations,
    early_withdrawals          = k.early_withdrawals          + r.early_withdrawals,
    walkovers_received         = k.walkovers_received         + r.walkovers_received,
    dispute_involvement_count  = k.dispute_involvement_count  + r.dispute_involvement_count,
    walkover_flag              = COALESCE(k.walkover_flag, FALSE) OR COALESCE(r.walkover_flag, FALSE),
    avg_confirmation_minutes   = CASE
      WHEN COALESCE(k.matches_completed, 0) + COALESCE(r.matches_completed, 0) = 0
        THEN COALESCE(k.avg_confirmation_minutes, r.avg_confirmation_minutes)
      ELSE ( COALESCE(k.avg_confirmation_minutes, 0) * COALESCE(k.matches_completed, 0)
             + COALESCE(r.avg_confirmation_minutes, 0) * COALESCE(r.matches_completed, 0) )
           / NULLIF(COALESCE(k.matches_completed, 0) + COALESCE(r.matches_completed, 0), 0)
    END,
    updated_at = NOW()
  FROM reliability_metrics r
  WHERE k.player_id = p_keep AND r.player_id = p_remove;

  -- The survivor may have NO ratings / reliability row at all: init_player_records
  -- fires on a status UPDATE, not on INSERT, so a directly-inserted roster row
  -- never got one. The UPDATE above then matches nothing and the loser's row
  -- cascades away — which is how a test merge silently erased a walkover_flag,
  -- the exact laundering the OR rule exists to stop. Worse for ratings: the
  -- merged player would be left with no rating row whatsoever.
  --
  -- So: adopt the loser's row when the survivor has none. There is nothing to
  -- reconcile in that case, and the loser's row is strictly better than absent.
  UPDATE reliability_metrics SET player_id = p_keep
   WHERE player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM reliability_metrics k WHERE k.player_id = p_keep);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('reliability_metrics', v_n); END IF;

  UPDATE ratings SET player_id = p_keep
   WHERE player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM ratings k WHERE k.player_id = p_keep);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('ratings', v_n); END IF;

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
    jsonb_build_object('kept_id', p_keep, 'kept_email', v_keep.email,
                       'login_moved', v_moved_user, 'rows_retained', v_kept),
    'Duplicate account merged'
  );

  RETURN jsonb_build_object('kept_id', p_keep, 'removed_id', p_remove,
                            'login_moved', v_moved_user, 'rows_retained', v_kept);
END;
$function$;

COMMENT ON FUNCTION public.merge_players(uuid, uuid, uuid) IS
  'Merges a duplicate player into a survivor. Refuses if the loser has matches, money or tournament history, or if the schema has a CASCADE reference to players that this function does not classify. Waivers, event waivers, passkeys and announcement reads are repointed rather than deleted; reliability metrics are merged (counters sum, confirmation time weighted, walkover flag OR-ed).';

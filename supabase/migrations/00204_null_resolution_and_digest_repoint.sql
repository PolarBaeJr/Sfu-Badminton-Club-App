-- 00204  The round-11 defects: a NULL resolution type, and a misclassified
--        digest delivery key.
--
-- Both of these are mine, from the two migrations immediately before this one.
-- Codex round 11 ruled F-002 RESOLVED on 00203 "with the separate NULL-input
-- defect above to fix before production", and rejected 00202's classification
-- of digest_deliveries. This migration closes both.
--
-- 1. resolve_dispute_unrated(NULL) silently converted the match to casual.
--    `NULL NOT IN (...)` is NULL, PL/pgSQL runs a NULL IF as false, so the
--    whitelist admitted it; `= 'voided'` is then also NULL, so the two-arm
--    dispatch fell into its ELSE. Confirmed on staging: the call returned
--    {"applied": true}, the match ended casual/voided, and the dispute closed
--    with resolution_type IS NULL. Fixed with an explicit NULL refusal AND an
--    exhaustive dispatch -- the defect class is "ELSE means convert", so the
--    NULL guard alone would leave the next added enum label doing the same
--    thing.
--
-- 2. digest_deliveries is NOT disposable. 00202 called it a per-account
--    delivery log structurally identical to notifications. It is not: it is
--    the weekly send's idempotency key and the only durable provider-message
--    link. 00202's stated reason -- "a deleted player is not in any future
--    digest run to be sent to" -- overlooks that the SURVIVOR represents the
--    same member and, after a cascade, holds no key for that week. Moved to
--    the repointed set, where the survivor's own row wins a collision.
--
-- Neither change touches a call site: resolve_dispute_unrated only tightens a
-- refusal the console's zod enum already made unreachable, and merge_players
-- keeps its return shape (digest_deliveries simply moves from the "dropped"
-- tally to the "kept" one).

BEGIN;

-- ---------------------------------------------------------------------
-- 1. resolve_dispute_unrated: refuse NULL, and dispatch exhaustively
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_dispute_unrated(p_dispute_id uuid, p_actor_id uuid, p_resolution_type dispute_resolution, p_resolution_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_dispute disputes;
BEGIN
  -- NULL is rejected on its own line and BEFORE the whitelist, because
  -- `NULL NOT IN (...)` evaluates to NULL and PL/pgSQL runs a NULL IF as the
  -- false branch. The whitelist below therefore admitted NULL silently, and
  -- the dispatch's old bare ELSE then converted the match to casual and closed
  -- the dispute with resolution_type = NULL. Confirmed on staging before this
  -- migration was written. Unreachable through the console today -- the zod
  -- enum in disputeResolveSchema is required and non-nullable -- but this
  -- function is the defense-in-depth boundary and its refusal has to be real.
  IF p_resolution_type IS NULL THEN
    RAISE EXCEPTION 'resolve_dispute_unrated needs a resolution type, not NULL'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF p_resolution_type NOT IN ('voided', 'converted_to_casual') THEN
    RAISE EXCEPTION 'resolve_dispute_unrated handles voided and converted_to_casual only, not %', p_resolution_type;
  END IF;

  -- The note is the reason of record for both the match note and the audit
  -- row, and neither column is worth writing empty.
  IF p_resolution_note IS NULL OR btrim(p_resolution_note) = '' THEN
    RAISE EXCEPTION 'A resolution note is required';
  END IF;

  SELECT * INTO v_dispute FROM disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_dispute IS NULL THEN
    RAISE EXCEPTION 'Dispute not found';
  END IF;

  -- THE IDEMPOTENCE KEY, read through the row lock before anything is written,
  -- exactly as resolve_dispute_rated reads it. This is what replaces
  -- claim_dispute_for_resolution: a second operator blocks here rather than
  -- racing to claim, and finds the work done.
  IF v_dispute.status = 'resolved' THEN
    RETURN jsonb_build_object('applied', false, 'already_resolved', true);
  END IF;

  -- Exhaustive on purpose: no bare ELSE. The guard above already refuses
  -- anything that is not one of these two, so this arm is unreachable today --
  -- it exists so that ADDING a dispute_resolution label cannot quietly route
  -- the new label into the conversion arm the way NULL did. The defect class
  -- was `ELSE means convert`, not NULL specifically.
  IF p_resolution_type = 'voided' THEN
    PERFORM void_club_match(v_dispute.match_id, p_actor_id, p_resolution_note);
  ELSIF p_resolution_type = 'converted_to_casual' THEN
    PERFORM convert_club_match_to_casual(v_dispute.match_id, p_actor_id, p_resolution_note);
  ELSE
    RAISE EXCEPTION 'resolve_dispute_unrated has no arm for %', p_resolution_type;
  END IF;

  -- No claimed_by fence on this UPDATE. The fence existed because the close
  -- was a separate round trip that could outlive a 15 minute claim TTL; the
  -- row lock taken above is held until this transaction commits, so there is
  -- no second writer to fence against.
  -- The claim fields are CLEARED, not just left behind. Two reasons, and the
  -- second is a live defect and not hygiene:
  --
  --   1. A resolved dispute that still carries claimed_resolution_type = X
  --      while resolution_type = Y is a row that contradicts itself for
  --      anybody reading it later.
  --
  --   2. During the rolling deploy this is a correctness fence. The OLD image
  --      closes the dispute from TypeScript with `.eq('claimed_by', admin.id)`.
  --      Sequence: old-image admin A claims (status -> under_review,
  --      claimed_by = A) and stalls mid-void; new-image admin B calls this
  --      function, takes the row lock, sees under_review, converts the match
  --      to casual and closes. A's stale close then runs — and if claimed_by
  --      were still A it would MATCH, silently overwriting resolution_type
  --      with A's. The dispute would then name a resolution that is not what
  --      happened to the match. Clearing claimed_by makes A's update match
  --      zero rows, which is A's existing ExpectedError ("took too long ...
  --      picked up by another admin") — the accurate message.
  --
  -- This does NOT fix the double MATCH mutation in that same window: A's void
  -- already committed before its close was refused. That remains a deploy
  -- constraint of the same shape as F-005 — drain the old image before
  -- applying — and the runbook is what carries it, not this function.
  UPDATE disputes
     SET status                  = 'resolved',
         resolution_type         = p_resolution_type,
         resolution_note         = p_resolution_note,
         resolved_by             = p_actor_id,
         resolved_at             = NOW(),
         claimed_by              = NULL,
         claimed_at              = NULL,
         claimed_resolution_type = NULL,
         updated_at              = NOW()
   WHERE id = p_dispute_id;

  -- Written HERE and not by the caller, which is the F-002 point: the dispute
  -- resolution is audited in the same transaction that performs it. The
  -- rated path still writes its dispute_resolved row from TypeScript — that
  -- asymmetry is real and deliberate, and it is recorded rather than papered
  -- over: this migration is scoped to the unrated pair.
  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (p_actor_id, 'dispute_resolved', 'dispute', p_dispute_id,
          jsonb_build_object('resolution_type', p_resolution_type), p_resolution_note);

  RETURN jsonb_build_object('applied', true, 'already_resolved', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_dispute_unrated(uuid, uuid, dispute_resolution, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_dispute_unrated(uuid, uuid, dispute_resolution, text) TO service_role;

-- ---------------------------------------------------------------------
-- 2. digest_deliveries: out of disposable(), into the repointed set
-- ---------------------------------------------------------------------

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
    ('reliability_metrics',  'player_id')    -- merged into the survivor's, then dropped
    -- digest_deliveries was listed here by 00202 and REMOVED by 00204: it is
    -- an idempotency key, not a log, so it is repointed in merge_players.
  ) AS t(tbl, col);
$function$;

CREATE OR REPLACE FUNCTION public.merge_players_unhandled()
 RETURNS TABLE(tbl text, col text)
 LANGUAGE sql
 STABLE
AS $function$
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
        ('head_to_head_stats','player_a_id'),
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
        ('player_discord_links','player_id'),
        -- Moved out of disposable() and into the repointed set by 00204.
        ('digest_deliveries','player_id')
      ) AS kept(tbl, col)
    );
$function$;

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

  -- digest_deliveries: REPOINTED, not disposable. 00202 classified this as a
  -- per-account delivery log like notifications and that was wrong. The row is
  -- not a log -- it is the weekly send's idempotency key (PK is
  -- (week_start, player_id)) AND the only durable link to the provider's
  -- message id. Dropping the removed account's rows drops the claim for the
  -- week in progress, and the survivor is the same human being, so the next
  -- run has nothing to collide with and mails them a second time. Worse, the
  -- in-flight run's completion UPDATE filters on the vanished player_id, so it
  -- matches zero rows and does not ask for a count: the send is never marked
  -- complete and nothing reports it.
  --
  -- The survivor's own row wins a week-level collision, because the survivor is
  -- who every future run looks up. The removed account's losing row is left to
  -- go with the account on the ON DELETE CASCADE, exactly like announcement_reads.
  -- The provider_message_id on that losing row is lost; the weekly key, which is
  -- what stops a duplicate email, is not.
  UPDATE digest_deliveries d SET player_id = p_keep
   WHERE d.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM digest_deliveries k
                      WHERE k.player_id = p_keep AND k.week_start = d.week_start);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('digest_deliveries', v_n); END IF;

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

REVOKE ALL ON FUNCTION public.merge_players(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players(uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;
REVOKE ALL ON FUNCTION public.merge_players_unhandled() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_unhandled() TO service_role;

-- ---------------------------------------------------------------------
-- Verify
--
-- The first assertion is BEHAVIOURAL, not a grep: it calls the function and
-- demands the refusal. A source-fragment check would pass on a body where the
-- guard is present but placed after the dispute lookup, which is exactly the
-- ordering bug that would make it useless. The digest half is checked as a
-- CENSUS -- merge_players_unhandled() must be empty -- because a fragment grep
-- for one table name cannot see a table that fell out of every class.
-- ---------------------------------------------------------------------
DO $verify$
DECLARE
  v_def       text;
  v_state     text;
  v_unhandled text;
BEGIN
  -- 1. NULL is actually refused, and refused BEFORE anything else runs.
  -- The dispute id is deliberately one that does not exist: if the NULL guard
  -- were placed after the lookup this would raise no_data_found instead, and
  -- catching OTHERS is what lets us tell those two apart rather than passing
  -- on any exception at all.
  v_state := NULL;
  BEGIN
    PERFORM resolve_dispute_unrated(
      '00000204-0000-4000-8000-000000000001'::uuid,
      '00000204-0000-4000-8000-000000000002'::uuid,
      NULL::dispute_resolution,
      'verify'
    );
  EXCEPTION WHEN others THEN
    v_state := SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '22004' THEN
    RAISE EXCEPTION '00204: resolve_dispute_unrated(NULL) did not refuse with null_value_not_allowed (sqlstate %)',
      COALESCE(v_state, 'none -- it RETURNED, which is the original defect');
  END IF;

  -- 2. The dispatch is exhaustive. Without this, a later edit could delete the
  -- NULL guard and restore the bare ELSE, and assertion 1 would still fail --
  -- but a NEW enum label would silently convert with nothing to catch it.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_dispute_unrated';
  IF v_def !~ 'ELSIF\s+p_resolution_type\s*=\s*''converted_to_casual''' THEN
    RAISE EXCEPTION '00204: the resolve_dispute_unrated dispatch is not exhaustive -- the conversion arm is still a bare ELSE';
  END IF;

  -- 3. digest_deliveries is out of the disposable set.
  IF EXISTS (SELECT 1 FROM merge_players_disposable() WHERE tbl = 'digest_deliveries') THEN
    RAISE EXCEPTION '00204: digest_deliveries is still classified disposable';
  END IF;

  -- 4. THE CENSUS. Removing it from disposable() without repointing it would
  -- leave it unclassified, and this is the only check that would notice.
  SELECT string_agg(tbl || '.' || col, ', ') INTO v_unhandled FROM merge_players_unhandled();
  IF v_unhandled IS NOT NULL THEN
    RAISE EXCEPTION '00204: these player references are in no merge class: %', v_unhandled;
  END IF;

  -- 5. The repoint really is week-scoped. A repoint without the week_start leg
  -- of the anti-join raises a unique violation the first time the survivor has
  -- any digest row at all, which no test with a single week would catch.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'merge_players';
  IF v_def !~ 'UPDATE digest_deliveries' THEN
    RAISE EXCEPTION '00204: merge_players does not repoint digest_deliveries';
  END IF;
  IF v_def !~ 'digest_deliveries k[\s\S]{0,120}k\.week_start\s*=\s*d\.week_start' THEN
    RAISE EXCEPTION '00204: the digest_deliveries repoint anti-join is not scoped to week_start';
  END IF;
END;
$verify$;

COMMIT;

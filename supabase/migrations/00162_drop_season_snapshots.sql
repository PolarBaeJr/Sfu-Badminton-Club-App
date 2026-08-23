-- 00162_drop_season_snapshots.sql
--
-- Drops public.season_snapshots, which has never held a row.
--
-- It was meant to be filled at season rollover by an edge function that is
-- invoked by hand and never has been; the `capture_season_snapshot` RPC it
-- would have called does not exist in the database. Three comments in the app
-- already document the table as unwritten (apps/admin/src/app/seasons/page.tsx,
-- apps/player/src/app/my-stats/past-season.tsx, and season-history.ts). No
-- application code queries it. season_final_ratings is the table that actually
-- carries end-of-season data, and it stays.
--
-- The reason this is a migration rather than a one-line DROP: two functions
-- name the table, and only one of them breaks.
--
--   merge_players_preview     counts rows in it. This is a real relation
--                             reference that plpgsql resolves at EXECUTION, so
--                             dropping the table alone would leave the admin
--                             merge tool throwing "relation does not exist" the
--                             first time anyone used it -- and per the merge
--                             work, nobody has used it yet, so it would sit
--                             broken and undetected.
--
--   merge_players_unhandled   names it only inside a VALUES list of text. That
--                             does not break. It goes quietly WRONG instead:
--                             it would keep asserting the table is "blocked by
--                             the guard" after the guard that blocked it is
--                             gone. Since the FK disappears with the table, the
--                             tuple stops matching anything anyway.
--
-- All three changes are in one transaction so the tool is never half-migrated.

BEGIN;

-- Functions first, so at no point in the transaction does a live definition
-- point at a table that is already gone.

CREATE OR REPLACE FUNCTION public.merge_players_preview(p_keep uuid, p_remove uuid)
 RETURNS TABLE(table_name text, row_count bigint, effect text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    UNION ALL SELECT 'club_fees',              count(*) FROM club_fees WHERE player_id = p_remove
    -- total_matches > 0 / matches_played > 0: a ZEROED row is a tombstone, not
    -- history. 00119 zeroes rather than deletes and adds no DELETE trigger, so
    -- a member whose matches were deleted keeps a row here with nothing in it.
    -- A loser with real matches is still refused — by this line and by
    -- match_participants above.
    UNION ALL SELECT 'head_to_head_stats',     count(*) FROM head_to_head_stats WHERE (player_a_id = p_remove OR player_b_id = p_remove) AND total_matches > 0
    UNION ALL SELECT 'partnership_stats',      count(*) FROM partnership_stats WHERE (player_a_id = p_remove OR player_b_id = p_remove) AND matches_played > 0
    -- season_snapshots was counted here until 00162 dropped it.
    UNION ALL SELECT 'season_final_ratings',   count(*) FROM season_final_ratings WHERE player_id = p_remove
    UNION ALL SELECT 'disputes (opened)',      count(*) FROM disputes WHERE opened_by = p_remove
    UNION ALL SELECT 'walkovers',              count(*) FROM walkovers WHERE forfeit_player_id = p_remove OR reported_by = p_remove
    UNION ALL SELECT 'event_feedback',         count(*) FROM event_feedback WHERE player_id = p_remove
    UNION ALL SELECT 'varsity_notes',          count(*) FROM varsity_notes WHERE player_id = p_remove OR author_id = p_remove
    UNION ALL SELECT 'legacy_tournament_participants', count(*) FROM legacy_tournament_participants WHERE player_id = p_remove OR partner_id = p_remove
  ) t
  ORDER BY t.n DESC, t.tbl;
END;
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
        ('announcement_reads','player_id'), ('passkey_credentials','player_id')
      ) AS kept(tbl, col)
    );
$function$;

-- Refuse to drop the table if it somehow acquired data between this file being
-- written and being run. An empty table is a dead feature; a populated one is
-- someone's season history and this migration is wrong about it.
DO $guard$
BEGIN
  IF to_regclass('public.season_snapshots') IS NOT NULL THEN
    IF (SELECT count(*) FROM public.season_snapshots) > 0 THEN
      RAISE EXCEPTION
        'season_snapshots is not empty (% rows); 00162 assumes it was never written to',
        (SELECT count(*) FROM public.season_snapshots);
    END IF;
  END IF;
END
$guard$;

-- Its two RLS policies, four indexes and outbound FKs go with it. Nothing has
-- an inbound FK to it and no view depends on it, so no CASCADE is needed.
DROP TABLE IF EXISTS public.season_snapshots;

COMMIT;

NOTIFY pgrst, 'reload schema';

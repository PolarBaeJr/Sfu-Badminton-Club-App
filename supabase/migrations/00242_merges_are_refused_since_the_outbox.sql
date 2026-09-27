-- ============================================================
-- 00242 MERGES ARE REFUSED SINCE THE OUTBOX
--
-- EVERY MEMBER MERGE ON PRODUCTION IS REFUSED TODAY. merge_players() raises
-- "Refusing to merge" whenever merge_players_unhandled() returns a row, and
-- since 00207 that guard sees every foreign key to players regardless of its
-- delete action. Two later migrations added SET NULL references and never
-- classified them:
--
--   discord_outbox.requested_by        00222
--   data_api_consumers.created_by      00241
--   data_api_keys.minted_by            00241
--   data_api_keys.revoked_by           00241
--
-- Read-only against prod on 2026-09-22, merge_players_unhandled() returned
-- exactly these four rows.
--
-- CLASSIFIED AS DISPOSABLE, which here means "let the FK's own SET NULL run":
-- merge_players never touches a disposable column, the final DELETE of the
-- removed account blanks it, and nothing throws. The cost is attribution only:
-- who queued an outbox message, and which exec minted or revoked a data API
-- key. The audit log keeps the actor for every one of those console actions,
-- and the survivor's audit rows are repointed by merge_players, so nothing is
-- lost that is not recorded elsewhere. Repointing instead would mean restating
-- the whole of merge_players (00216) for four attribution columns.
--
-- The five rows 00204 left in merge_players_disposable() are restated
-- verbatim. digest_deliveries is NOT among them: 00204 moved it to repointed.
-- ============================================================

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
    -- SET NULL attribution, blanked by the removed account's DELETE (00242).
    ('discord_outbox',       'requested_by'),
    ('data_api_consumers',   'created_by'),
    ('data_api_keys',        'minted_by'),
    ('data_api_keys',        'revoked_by')
    -- digest_deliveries was listed here by 00202 and REMOVED by 00204: it is
    -- an idempotency key, not a log, so it is repointed in merge_players.
  ) AS t(tbl, col);
$function$;

REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;

DO $verify$
DECLARE
  v_gap text;
BEGIN
  SELECT string_agg(format('%s.%s', tbl, col), ', ') INTO v_gap
    FROM public.merge_players_unhandled();
  IF v_gap IS NOT NULL THEN
    RAISE EXCEPTION '00242: merges would still be refused, unclassified: %', v_gap;
  END IF;
END
$verify$;

COMMIT;

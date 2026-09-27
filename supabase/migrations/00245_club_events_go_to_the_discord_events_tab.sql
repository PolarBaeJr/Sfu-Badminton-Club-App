-- ============================================================
-- 00245 CLUB EVENTS GO TO THE DISCORD EVENTS TAB
--
-- A published club event (00244) gets a Discord scheduled event, the same
-- way an active tournament does (00169). This table maps a club event to the
-- Discord event it produced, plus a copy of what was last pushed. What is due
-- is decided in apps/player/src/app/api/discord/club-events/route.ts; the bot
-- calls Discord first and writes here second.
--
-- NO NEW SCHEDULE. The club-events pass rides 00169's
-- discord-tournament-events job: the bot's POST /tournament-events runs the
-- tournament pass and then this one. So this file touches neither cron.job
-- nor cron_config.
--
-- NO PLAYER COLUMN, so merge_players_disposable() is not restated. The verify
-- block asserts the merge guard is still empty and still eleven rows.
--
-- REQUIRES 00244 APPLIED FIRST.
-- ============================================================

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.club_events') IS NULL THEN
    RAISE EXCEPTION '00245: apply 00244 first, public.club_events does not exist';
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.discord_club_events (
  -- NO FOREIGN KEY ON club_event_id, for 00169's reason. deleteClubEvent
  -- (apps/admin/src/lib/actions/club-events.ts) hard-deletes the row, and a
  -- CASCADE would take this mapping with it: the mapping is the only thing
  -- that knows which Discord event belongs to it, so the Discord event would
  -- stay up forever. The route treats a mapping whose club event no longer
  -- resolves as a cancel.
  club_event_id      uuid        NOT NULL,
  guild_id           text        NOT NULL,
  discord_event_id   text        NOT NULL,

  -- What was last pushed, compared on every tick to decide whether a PATCH is
  -- owed. The event's own values, never the clamped start that was sent.
  synced_name        text        NOT NULL,
  synced_starts_at   timestamptz NOT NULL,
  synced_ends_at     timestamptz NOT NULL,
  -- Null when the event has no location and the bot sent its fallback.
  synced_location    text,
  synced_description text        NOT NULL DEFAULT '',

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (club_event_id, guild_id)
);

COMMENT ON TABLE public.discord_club_events IS
  'Club event -> Discord scheduled event mapping, plus the last values pushed. Written by the bot after a confirmed Discord call, never before.';

ALTER TABLE public.discord_club_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discord_club_events FROM PUBLIC;
REVOKE ALL ON TABLE public.discord_club_events FROM anon, authenticated;
GRANT ALL  ON TABLE public.discord_club_events TO service_role;

DO $verify$
DECLARE
  v_gap text;
  v_priv text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.discord_club_events'::regclass) THEN
    RAISE EXCEPTION '00245: RLS is not enabled on discord_club_events';
  END IF;

  FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
    IF has_table_privilege('anon', 'public.discord_club_events', v_priv)
       OR has_table_privilege('authenticated', 'public.discord_club_events', v_priv) THEN
      RAISE EXCEPTION '00245: anon or authenticated holds % on discord_club_events', v_priv;
    END IF;
    IF NOT has_table_privilege('service_role', 'public.discord_club_events', v_priv) THEN
      RAISE EXCEPTION '00245: service_role lacks % on discord_club_events', v_priv;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.discord_club_events'::regclass AND contype = 'f') THEN
    RAISE EXCEPTION '00245: discord_club_events must carry no foreign key';
  END IF;

  SELECT string_agg(format('%s.%s', tbl, col), ', ') INTO v_gap
    FROM public.merge_players_unhandled();
  IF v_gap IS NOT NULL THEN
    RAISE EXCEPTION '00245: merges would be refused, unclassified: %', v_gap;
  END IF;
  IF (SELECT count(*) FROM public.merge_players_disposable()) <> 11 THEN
    RAISE EXCEPTION '00245: merge_players_disposable is not the eleven rows of 00244';
  END IF;
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- OWNER STEPS
-- 1. Nothing new in Discord: the bot already needs MANAGE_EVENTS for 00169.
-- 2. No slash command ships with this, so no `npm run register -w bot`.
-- 3. If somebody deletes a club event's Discord event by hand, it is not
--    re-created (same as 00169). To force it back:
--      DELETE FROM discord_club_events WHERE club_event_id = '<id>';
-- ============================================================================

-- ============================================================
-- 00155_deletion_reaches_the_audit_trails.sql — the two permanent logs a
-- deletion never touched
-- ============================================================
-- SAFE TO APPLY AT ANY TIME, IN EITHER ORDER RELATIVE TO THE APP DEPLOY.
-- Nothing here is read or called by application code. The app-layer half of
-- FIX-LIST #17 (supabase/functions/_shared/anonymize.ts and
-- apps/admin/src/lib/auditable-player.ts) stops NEW identity from reaching
-- these tables and needs no function from this file; this file cleans up what
-- is already in them and leaves behind a function the nightly job can be
-- pointed at later. Deploy first or apply first — neither breaks the other.
--
-- ------------------------------------------------------------
-- WHAT SURVIVES A DELETION TODAY
-- ------------------------------------------------------------
-- The deletion email promises, in these words, that "your name, email address,
-- phone number, profile photo and bio are erased for good". The purge job keeps
-- that promise on `public.players` and nowhere else. Two permanent logs hold
-- the same facts and neither is touched:
--
--   auth.audit_log_entries   GoTrue writes one row per sign-in, sign-out, token
--                            refresh, recovery and user-deletion, and every one
--                            carries the account's EMAIL ADDRESS in
--                            payload->>'actor_username'. 730 rows on
--                            production. `auth.admin.deleteUser` deletes the
--                            auth.users row and leaves all of them. So a
--                            deleted member's address is still in the database,
--                            timestamped, alongside their sign-in times.
--
--   public.audit_logs        Four admin actions read the whole player row with
--                            select('*') and wrote it into `old_value`. 26 rows
--                            on production hold an address. 00139 deliberately
--                            made this table survive the deletion of the player
--                            it is about — which is right for the RECORD OF THE
--                            ACT and wrong for a copy of the person.
--
-- ------------------------------------------------------------
-- WHAT THIS FILE DOES NOT DO
-- ------------------------------------------------------------
-- It does not delete audit rows. An audit trail with holes in it is worse than
-- one with redactions: the club needs to be able to show that a ban happened,
-- who did it and when, long after the member is gone. Every row here keeps its
-- id, its timestamp, its action and its target. What comes out is the identity,
-- replaced by a marker that says so.
--
-- It does not touch rows belonging to accounts that still exist. The scrub is
-- keyed on the auth user being GONE — which, in this system, is the definition
-- of a purged account, because both purge jobs delete the auth user and null
-- `players.user_id` in the same pass.
--
-- It does not touch the free text NOBODY WROTE ABOUT THEMSELVES — a coach's
-- `varsity_notes.note`, an exec's `players.ban_reason`, a fee's
-- `reinstatement_fees.ban_reason`, a dispute's `resolution_note`. Those are
-- deliberately left, and the reasoning belongs to the club rather than to this
-- file: `reinstatement_fees.ban_reason` in particular is attached to money and
-- to the ban-episode key `club_fees_reinstatement_ban_key`, so erasing it would
-- break the reconstruction that 00145 depends on. They are listed in
-- docs/sensitive/MIGRATIONS-TO-APPLY-2026-08-18.md as the owner's call.
--
-- It does not clear `players.deletion_requested_at`. That tombstone is what the
-- purge query itself uses to find eligible rows, it names nobody, and it is not
-- readable by members (00032 does not grant it).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. The scrub, as a function, so it can be run again
-- ------------------------------------------------------------
-- SECURITY DEFINER because `auth.audit_log_entries` belongs to supabase_auth_admin
-- and is not reachable by any application role. Granted to service_role ONLY —
-- not to authenticated, and not to anon.
--
-- No application code calls this yet, on purpose: adding a call would create a
-- window in which the deployed app depends on a function the owner has not
-- applied. Once this file is applied everywhere, wiring it into the daily cron
-- (or into the two purge jobs, after their anonymising update) is a one-line
-- change with no ordering hazard left.

CREATE OR REPLACE FUNCTION public.scrub_deleted_identity()
RETURNS TABLE(auth_rows_scrubbed int, audit_rows_scrubbed int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  v_auth   int := 0;
  v_traits int := 0;
  v_audit  int := 0;
BEGIN
  -- ---- auth.audit_log_entries -------------------------------------------
  -- `payload` is `json` (not jsonb) in GoTrue, so it is cast both ways. The
  -- WHERE clause is what keeps this to purged accounts: the row names an actor
  -- uuid that no longer exists in auth.users. Rows with no actor_id at all
  -- (some token events) are left — they name nobody to begin with.
  --
  -- actor_username is replaced rather than removed so the payload keeps its
  -- shape and anything reading it still finds the key.
  UPDATE auth.audit_log_entries a
     SET payload = (
           jsonb_set(
             jsonb_set(a.payload::jsonb, '{actor_username}', '"deleted@deleted.invalid"'::jsonb, false),
             '{traits}', '{}'::jsonb, false
           )
         )::json
   WHERE (a.payload::jsonb ->> 'actor_id') IS NOT NULL
     AND (a.payload::jsonb ->> 'actor_id') ~ '^[0-9a-fA-F-]{36}$'
     AND NOT EXISTS (
           SELECT 1 FROM auth.users u
            WHERE u.id = (a.payload::jsonb ->> 'actor_id')::uuid
         )
     AND COALESCE(a.payload::jsonb ->> 'actor_username', '') <> 'deleted@deleted.invalid';
  GET DIAGNOSTICS v_auth = ROW_COUNT;

  -- The second shape, which the actor_id rule above cannot reach. On a
  -- `user_deleted` event GoTrue files the row under the ADMIN who pressed the
  -- button — so `actor_id` is a live account and `actor_username` is the
  -- admin's own address, both of which should stay. The DELETED member's
  -- address is in `traits`, and by the nature of the event that account is gone
  -- by definition, so these need no existence check. Missing this shape would
  -- have left one row per deletion still naming the person it deleted.
  UPDATE auth.audit_log_entries a
     SET payload = jsonb_set(a.payload::jsonb, '{traits}', '{}'::jsonb, false)::json
   WHERE a.payload::jsonb ->> 'action' = 'user_deleted'
     AND jsonb_typeof(a.payload::jsonb -> 'traits') = 'object'
     AND (a.payload::jsonb -> 'traits') <> '{}'::jsonb;
  GET DIAGNOSTICS v_traits = ROW_COUNT;
  v_auth := v_auth + v_traits;

  -- ---- public.audit_logs -------------------------------------------------
  -- Only rows about a player, and only players who have actually been purged —
  -- both purge jobs null `players.user_id` in the same statement that
  -- anonymises the row, so `user_id IS NULL AND email LIKE 'deleted+%'` is the
  -- purged set. A row about a live member keeps everything; this is a cleanup
  -- of erasures already performed, not a new redaction policy.
  --
  -- The key list mirrors WITHHELD_COLUMNS in
  -- apps/admin/src/lib/auditable-player.ts. `#-` removes a key if present and
  -- is a no-op otherwise, at both the top level and under the `player` key that
  -- updatePlayer and setPlayerAccessLevel nest their rows in.
  WITH purged AS (
    SELECT p.id
      FROM public.players p
     WHERE p.user_id IS NULL
       AND p.email LIKE 'deleted+%@deleted.invalid'
  ), scrubbed AS (
    UPDATE public.audit_logs l
       SET old_value = public.strip_identity_keys(l.old_value),
           new_value = public.strip_identity_keys(l.new_value)
     WHERE l.target_type = 'player'
       AND l.target_id IN (SELECT id FROM purged)
       AND (
             public.strip_identity_keys(l.old_value) IS DISTINCT FROM l.old_value
          OR public.strip_identity_keys(l.new_value) IS DISTINCT FROM l.new_value
       )
    RETURNING 1
  )
  SELECT count(*)::int INTO v_audit FROM scrubbed;

  RETURN QUERY SELECT v_auth, v_audit;
END;
$function$;

-- The key-stripper, separate so the UPDATE above can use it three times and so
-- it can be read on its own. IMMUTABLE: same input, same output, no reads.
CREATE OR REPLACE FUNCTION public.strip_identity_keys(v jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_temp'
AS $function$
  SELECT CASE
    WHEN v IS NULL OR jsonb_typeof(v) <> 'object' THEN v
    ELSE (
      -- Top level, then the same list again under `player`.
      CASE
        WHEN jsonb_typeof(v -> 'player') = 'object'
        THEN jsonb_set(
               v #- '{first_name}' #- '{last_name}' #- '{full_name}'
                 #- '{display_name}' #- '{handle}' #- '{email}' #- '{phone}'
                 #- '{avatar_url}' #- '{exec_photo_url}' #- '{bio}'
                 #- '{exec_bio}' #- '{user_id}' #- '{notification_preferences}',
               '{player}',
               (v -> 'player')
                 #- '{first_name}' #- '{last_name}' #- '{full_name}'
                 #- '{display_name}' #- '{handle}' #- '{email}' #- '{phone}'
                 #- '{avatar_url}' #- '{exec_photo_url}' #- '{bio}'
                 #- '{exec_bio}' #- '{user_id}' #- '{notification_preferences}',
               false
             )
        ELSE v #- '{first_name}' #- '{last_name}' #- '{full_name}'
               #- '{display_name}' #- '{handle}' #- '{email}' #- '{phone}'
               #- '{avatar_url}' #- '{exec_photo_url}' #- '{bio}'
               #- '{exec_bio}' #- '{user_id}' #- '{notification_preferences}'
      END
    )
  END;
$function$;

REVOKE ALL ON FUNCTION public.scrub_deleted_identity()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.strip_identity_keys(jsonb)      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scrub_deleted_identity()     TO service_role;
GRANT EXECUTE ON FUNCTION public.strip_identity_keys(jsonb)   TO service_role;

COMMENT ON FUNCTION public.scrub_deleted_identity() IS
  'FIX-LIST #17. Removes the identity of already-purged accounts from the two permanent audit trails that auth.admin.deleteUser and the purge jobs never touched: auth.audit_log_entries (email in payload.actor_username) and public.audit_logs (whole player rows in old_value). Keeps every row, its timestamp, its action and its target — this redacts, it does not delete. Idempotent: a second run scrubs nothing. Safe to schedule daily. service_role only.';

COMMENT ON FUNCTION public.strip_identity_keys(jsonb) IS
  'Removes the identifying keys from an audit_logs value, at the top level and under a nested `player` key. The list mirrors WITHHELD_COLUMNS in apps/admin/src/lib/auditable-player.ts; if one changes, change the other.';

COMMIT;

-- ============================================================
-- 2. RUN IT ONCE, NOW — this is the backfill
-- ============================================================
-- Outside the transaction above so the counts print even if you are running
-- this file statement by statement. Expect roughly 730 auth rows and 26 audit
-- rows on production the first time, and 0 and 0 on every run after.
--
--   SELECT * FROM public.scrub_deleted_identity();
--
-- BEFORE YOU RUN IT, if you want to see what it will change:
--
--   SELECT count(*) FROM auth.audit_log_entries a
--    WHERE (a.payload::jsonb ->> 'actor_id') ~ '^[0-9a-fA-F-]{36}$'
--      AND NOT EXISTS (SELECT 1 FROM auth.users u
--                       WHERE u.id = (a.payload::jsonb ->> 'actor_id')::uuid);
--
--   SELECT l.id, l.action_type, l.created_at
--     FROM public.audit_logs l
--     JOIN public.players p ON p.id = l.target_id
--    WHERE l.target_type = 'player'
--      AND p.user_id IS NULL
--      AND p.email LIKE 'deleted+%@deleted.invalid'
--      AND public.strip_identity_keys(l.old_value) IS DISTINCT FROM l.old_value;
--
-- AND AFTERWARDS, the check that it worked — both must return 0:
--
--   SELECT count(*) FROM auth.audit_log_entries a
--    WHERE (a.payload::jsonb ->> 'actor_id') ~ '^[0-9a-fA-F-]{36}$'
--      AND NOT EXISTS (SELECT 1 FROM auth.users u
--                       WHERE u.id = (a.payload::jsonb ->> 'actor_id')::uuid)
--      AND COALESCE(a.payload::jsonb ->> 'actor_username','') <> 'deleted@deleted.invalid';
--
--   SELECT count(*) FROM public.audit_logs l
--     JOIN public.players p ON p.id = l.target_id
--    WHERE l.target_type = 'player' AND p.user_id IS NULL
--      AND p.email LIKE 'deleted+%@deleted.invalid'
--      AND public.strip_identity_keys(l.old_value) IS DISTINCT FROM l.old_value;
--
-- ============================================================
-- 3. STILL YOURS AFTER THIS
-- ============================================================
-- GoTrue keeps writing auth.audit_log_entries forever, for LIVE members too,
-- and this file does not bound that. A retention policy — "delete auth audit
-- rows older than N months" — is a separate decision about how long the club
-- wants to be able to investigate a login, and it is not one to take inside a
-- privacy fix. If you want it, it is one DELETE on a schedule, and the
-- honest place to write it down is the same handover doc.

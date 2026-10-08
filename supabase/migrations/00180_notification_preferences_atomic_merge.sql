-- 00180_notification_preferences_atomic_merge.sql
--
-- notification_preferences is a JSONB blob holding every push toggle, every
-- email category and the session-reminder lead time. Both writers — the
-- settings screen and the one-click unsubscribe link — patch it by SELECTing
-- the blob, merging in JavaScript, and UPDATEing the whole object back.
--
-- That has two failure modes, and under the opt-in model of 00058 both of them
-- silently UNSUBSCRIBE somebody, because a key that is absent is a key that is
-- off.
--
--   1. A FAILED READ IS AN EMPTY OBJECT. supabase-js resolves rather than
--      rejects, so a transient error left `existing` null, the merge started
--      from {}, and the successful UPDATE that followed replaced the member's
--      entire preference set with just the keys they happened to submit. One
--      push toggle flipped during a database hiccup wipes every email
--      preference and the reminder lead time.
--
--   2. TWO CONCURRENT PATCHES LOSE ONE. Both read the same blob and both write
--      their own merge; last writer wins and the other change is gone. Two
--      controls saved in quick succession on the settings screen is enough.
--
-- Neither is fixable in the client, because the read and the write are two
-- statements no matter how carefully they are ordered. `||` on jsonb inside a
-- single UPDATE is one statement: the row is locked, the current value is the
-- one being merged into, and there is no window.
--
-- The caller keeps its whitelist. This function decides nothing about WHICH
-- keys may be written — it only guarantees that writing them cannot destroy
-- the ones that were not sent.

BEGIN;

-- The member's own preferences. Takes no player id ON PURPOSE: it resolves the
-- caller through auth.uid(), so there is no parameter to point at somebody
-- else's row.
CREATE OR REPLACE FUNCTION public.merge_my_notification_preferences(p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_player_id uuid;
  v_merged jsonb;
BEGIN
  v_player_id := get_player_id(auth.uid());
  IF v_player_id IS NULL THEN
    RAISE EXCEPTION 'No player for the calling user';
  END IF;

  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'patch must be a json object';
  END IF;

  UPDATE players
     SET notification_preferences = COALESCE(notification_preferences, '{}'::jsonb) || p_patch,
         updated_at = NOW()
   WHERE id = v_player_id
  RETURNING notification_preferences INTO v_merged;

  IF v_merged IS NULL THEN
    RAISE EXCEPTION 'Player % not found', v_player_id;
  END IF;

  RETURN v_merged;
END;
$function$;

REVOKE ALL ON FUNCTION public.merge_my_notification_preferences(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_my_notification_preferences(jsonb) TO authenticated;

-- The unsubscribe link's variant. It has no session at all — that is the whole
-- point of a one-click unsubscribe — so it keys by the address the signed token
-- carries and runs as the service role.
CREATE OR REPLACE FUNCTION public.merge_notification_preferences_by_email(p_email text, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_merged jsonb;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'patch must be a json object';
  END IF;

  UPDATE players
     SET notification_preferences = COALESCE(notification_preferences, '{}'::jsonb) || p_patch,
         updated_at = NOW()
   WHERE email = p_email
  RETURNING notification_preferences INTO v_merged;

  -- NULL means no player carries that address. That is a legitimate state for
  -- an unsubscribe — the caller falls back to an address-level suppression —
  -- so it is reported rather than raised.
  RETURN v_merged;
END;
$function$;

REVOKE ALL ON FUNCTION public.merge_notification_preferences_by_email(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_notification_preferences_by_email(text, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

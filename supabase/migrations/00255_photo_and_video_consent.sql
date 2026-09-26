-- ============================================================
-- 00255 PHOTO AND VIDEO CONSENT
--
-- WHAT IT IS FOR. The proposed privacy policy (section 2, "Photograph and
-- video consent"), the participation waiver (section 6) and the terms of use
-- (section 10) promise one optional permission: may the club use photos or
-- video of this person for club promotion, on its website and social media.
-- Off unless turned on, separate from the waiver, withdrawable at any time, no
-- effect on membership or access, and the club records whether it is given
-- and WHEN it last changed.
--
-- WHAT IS CREATED
--   players.media_consent, players.media_consent_changed_at
--   guest_waiver_signings.media_consent, .media_consent_changed_at
--   stamp_media_consent_changed_at()        trigger function, on both tables
--   set_my_media_consent(boolean)           member RPC, the 00180 shape
--   set_guest_media_consent(text, boolean)  service role only, by proof token
--
-- THE TIME IS THE DATABASE'S. The trigger overwrites media_consent_changed_at
-- on every UPDATE of either table, whoever the writer is: now() when
-- media_consent changes, OLD otherwise. On INSERT it keeps a supplied time for
-- a row that arrives consenting (a reload of existing rows must not restamp
-- every date to the load time) and otherwise sets now() or NULL.
--
-- THE PRIVILEGED-COLUMN GUARD IS LEFT UNCHANGED, and this is its answer for
-- both columns (the 2026-08-20 audit rule: an answer, never an omission).
--   media_consent            NOT in the guard. set_my_media_consent writes it
--                            as the owner with the member's auth.uid() set, so
--                            the guard's UPDATE arm runs; listing it would
--                            refuse every member's own switch. It grants no
--                            access and the member is the one entitled to it,
--                            as with tours_seen and notification_preferences.
--   media_consent_changed_at NOT in the guard. Unwritable by construction: no
--                            member grant, and the trigger owns it on UPDATE
--                            for every writer, service role included.
-- Neither gets a column UPDATE grant (00182 stays at twelve) or a SELECT
-- grant: players_select opens any approved member's row to every member, so
-- the column grant is the only privacy there is. A member reads their own
-- value through a server action.
--
-- MERGES. merge_players (00216) keeps the survivor's row and deletes the
-- other, and neither column is a foreign key, so merge_players_unhandled() is
-- unaffected. When the two accounts disagree the console's mergePlayers turns
-- the survivor's consent OFF afterwards: a withdrawal made on the removed
-- account must not be lost, and off is what the policy promises by default.
--
-- GUESTS. 00254's signing columns stay as they are; the two consent columns
-- are the one revocable choice on the row, written only by
-- set_guest_media_consent(). sign_guest_waiver is NOT changed: dropping its
-- six-argument signature would break guest signing on any container still
-- running the old code during a deploy.
--
-- NO BACKFILL. Every existing row starts off, with changed_at NULL meaning
-- "never chosen".
--
-- PRECONDITION: 00254.
-- ============================================================

BEGIN;

-- 0. PRECONDITIONS -------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regclass('public.guest_waiver_signings') IS NULL THEN
    RAISE EXCEPTION '00255: apply 00254 first';
  END IF;
  IF to_regprocedure('public.get_player_id(uuid)') IS NULL THEN
    RAISE EXCEPTION '00255: public.get_player_id(uuid) is missing';
  END IF;
END
$pre$;

-- 1. COLUMNS -------------------------------------------------------------------
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS media_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS media_consent_changed_at timestamptz;

ALTER TABLE public.guest_waiver_signings
  ADD COLUMN IF NOT EXISTS media_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS media_consent_changed_at timestamptz;

-- Consent that is on always says when it was given.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_media_consent_has_time;
ALTER TABLE public.players ADD CONSTRAINT players_media_consent_has_time
  CHECK (NOT media_consent OR media_consent_changed_at IS NOT NULL);
ALTER TABLE public.guest_waiver_signings DROP CONSTRAINT IF EXISTS guest_waiver_signings_media_consent_has_time;
ALTER TABLE public.guest_waiver_signings ADD CONSTRAINT guest_waiver_signings_media_consent_has_time
  CHECK (NOT media_consent OR media_consent_changed_at IS NOT NULL);

COMMENT ON COLUMN public.players.media_consent IS
  'Photo and video consent for club promotion. Off unless the member turns it on; no effect on membership or access. Written by set_my_media_consent(). Not in the privileged-column guard, no member grant: see 00255.';
COMMENT ON COLUMN public.players.media_consent_changed_at IS
  'When media_consent last changed. Owned by stamp_media_consent_changed_at(); NULL means never chosen.';
COMMENT ON COLUMN public.guest_waiver_signings.media_consent IS
  'A guest''s photo and video consent. Off unless ticked; changed only by set_guest_media_consent() via the proof token. The one revocable choice on an otherwise fixed signing record.';
COMMENT ON COLUMN public.guest_waiver_signings.media_consent_changed_at IS
  'When media_consent last changed. Owned by stamp_media_consent_changed_at().';

-- 2. THE STAMP -----------------------------------------------------------------
-- NOT SECURITY DEFINER: it only assigns NEW and reads nothing.
CREATE OR REPLACE FUNCTION public.stamp_media_consent_changed_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.media_consent_changed_at := CASE
      WHEN NEW.media_consent THEN coalesce(NEW.media_consent_changed_at, now())
      ELSE NEW.media_consent_changed_at
    END;
  ELSIF NEW.media_consent IS DISTINCT FROM OLD.media_consent THEN
    NEW.media_consent_changed_at := now();
  ELSE
    NEW.media_consent_changed_at := OLD.media_consent_changed_at;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.stamp_media_consent_changed_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS stamp_media_consent_trg ON public.players;
CREATE TRIGGER stamp_media_consent_trg
  BEFORE INSERT OR UPDATE ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.stamp_media_consent_changed_at();

DROP TRIGGER IF EXISTS stamp_media_consent_trg ON public.guest_waiver_signings;
CREATE TRIGGER stamp_media_consent_trg
  BEFORE INSERT OR UPDATE ON public.guest_waiver_signings
  FOR EACH ROW EXECUTE FUNCTION public.stamp_media_consent_changed_at();

-- 3. THE MEMBER'S SWITCH (the 00180 shape) --------------------------------------
-- Takes no player id: it resolves the caller from auth.uid(). Deliberately NO
-- standing check: a pending, suspended or banned member must be able to
-- withdraw at any time.
CREATE OR REPLACE FUNCTION public.set_my_media_consent(p_consent boolean)
RETURNS TABLE (media_consent boolean, media_consent_changed_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_player uuid;
BEGIN
  IF p_consent IS NULL THEN
    RAISE EXCEPTION 'consent must be true or false';
  END IF;
  v_player := public.get_player_id(auth.uid());
  IF v_player IS NULL THEN
    RAISE EXCEPTION 'No player for the calling user' USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
    UPDATE public.players p
       SET media_consent = p_consent
     WHERE p.id = v_player
    RETURNING p.media_consent, p.media_consent_changed_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player % not found', v_player;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_my_media_consent(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_my_media_consent(boolean) TO authenticated, service_role;

-- 4. THE GUEST'S SWITCH, BY PROOF TOKEN ------------------------------------------
-- Service role only, like sign_guest_waiver: the guest reaches a Next server
-- action, never PostgREST.
CREATE OR REPLACE FUNCTION public.set_guest_media_consent(p_token text, p_consent boolean)
RETURNS TABLE (media_consent boolean, media_consent_changed_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_email text;
BEGIN
  IF p_consent IS NULL OR p_token IS NULL OR p_token !~ '^[0-9a-f]{48}$' THEN
    RAISE EXCEPTION 'Not a guest waiver link'
      USING ERRCODE = 'P0001', HINT = 'guest_media_consent_not_found';
  END IF;

  SELECT g.email INTO v_email FROM public.guest_waiver_signings g WHERE g.token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not a guest waiver link'
      USING ERRCODE = 'P0001', HINT = 'guest_media_consent_not_found';
  END IF;

  -- A withdrawal reaches every signing under the same email: a guest who came
  -- twice holds two proof links, and withdrawing on one must not leave the
  -- other consenting. Consent itself stays on this link's row only, so typing
  -- somebody else's email into the form cannot switch theirs on.
  IF NOT p_consent THEN
    UPDATE public.guest_waiver_signings g
       SET media_consent = false
     WHERE g.email = v_email AND g.token <> p_token AND g.media_consent;
  END IF;

  RETURN QUERY
    UPDATE public.guest_waiver_signings g
       SET media_consent = p_consent
     WHERE g.token = p_token
    RETURNING g.media_consent, g.media_consent_changed_at;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_guest_media_consent(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_guest_media_consent(text, boolean) TO service_role;

-- 5. VERIFY --------------------------------------------------------------------
DO $verify$
DECLARE
  v_member text := 'public.set_my_media_consent(boolean)';
  v_guest  text := 'public.set_guest_media_consent(text,boolean)';
  v_col    text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['media_consent', 'media_consent_changed_at'] LOOP
    IF has_column_privilege('authenticated', 'public.players', v_col, 'UPDATE')
       OR has_column_privilege('authenticated', 'public.players', v_col, 'SELECT')
       OR has_column_privilege('anon', 'public.players', v_col, 'UPDATE')
       OR has_column_privilege('anon', 'public.players', v_col, 'SELECT') THEN
      RAISE EXCEPTION '00255: a member role holds a privilege on players.%', v_col;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname = 'stamp_media_consent_trg' AND NOT tgisinternal
         AND tgrelid IN ('public.players'::regclass, 'public.guest_waiver_signings'::regclass)) <> 2 THEN
    RAISE EXCEPTION '00255: the stamp trigger is not on both tables';
  END IF;
  IF has_function_privilege('anon', v_member, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_member, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_member, 'EXECUTE') THEN
    RAISE EXCEPTION '00255: % has the wrong grants', v_member;
  END IF;
  IF has_function_privilege('anon', v_guest, 'EXECUTE')
     OR has_function_privilege('authenticated', v_guest, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_guest, 'EXECUTE') THEN
    RAISE EXCEPTION '00255: % must be service_role only', v_guest;
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_member::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_guest::regprocedure) THEN
    RAISE EXCEPTION '00255: an RPC is not SECURITY DEFINER';
  END IF;
  -- 00254's table lock must survive: still read-only for service_role.
  IF has_table_privilege('service_role', 'public.guest_waiver_signings', 'INSERT')
     OR has_table_privilege('service_role', 'public.guest_waiver_signings', 'UPDATE')
     OR has_table_privilege('service_role', 'public.guest_waiver_signings', 'DELETE') THEN
    RAISE EXCEPTION '00255: service_role gained a write on guest_waiver_signings';
  END IF;
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';

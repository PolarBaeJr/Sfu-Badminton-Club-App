-- 00252: a named payment waits for its member.
--
-- An exec records "Add a name" for somebody who paid their dues before they had
-- an account. Until now that row was a name and nothing else, so when the same
-- person signed up the console showed them unpaid beside a stranger's paid row,
-- and an exec had to notice, mark them paid and delete the manual entry by hand.
--
-- Now the exec may also give an email. When a players row is created with that
-- email, or an existing row's email changes to it, the trigger below moves the
-- payment onto the account: player_id is set and manual_name and manual_email
-- are cleared in one UPDATE, which is exactly the shape club_fees_check
-- (num_nonnulls(player_id, manual_name) = 1) wants on the other side.
--
-- WHAT IS NOT CLAIMED.
--   * A season where the member already has a dues row. club_fees_dues_player_
--     season_key allows one per member per season, and which of two payments is
--     the real one is an exec's call, so the named row stays manual and visible.
--   * A tombstoned address (%@deleted.invalid): a purged account must never
--     inherit anything.
--   * Anything, if the claim itself fails. It runs inside its own EXCEPTION
--     block and only RAISEs a WARNING: a signup must never fail because a
--     payment could not be moved. The row simply stays manual.
--
-- The console refuses an email that already belongs to an account (the payment
-- belongs on that member's own row), so a claim only ever meets a NEW address.
--
-- RETENTION. The email of somebody who is not (yet) a member sits on the
-- club_fees row until a signup claims it or an exec removes the entry; nothing
-- expires it. The manual_fee_added audit row also records it in new_value, and
-- audit_logs keeps that for as long as it keeps anything. The claim's own audit
-- row does not repeat the email: the account it moved to already carries it.
--
-- players.email is lowercased by normalize_player_email_trg (BEFORE), so NEW
-- here is already normalised, and the CHECK below holds manual_email to the
-- same form.
--
-- PRECONDITION: 00249. This file was written against a database that has it,
-- and refuses to run on one that does not rather than assume the order.

BEGIN;

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'reverse_match_result'
       AND pronamespace = 'public'::regnamespace
       AND prosrc LIKE '%season_final_ratings%'
  ) THEN
    RAISE EXCEPTION '00252: 00249 is not applied (reverse_match_result does not touch season_final_ratings)';
  END IF;
END
$pre$;

-- 1. THE COLUMN ----------------------------------------------------------------
ALTER TABLE public.club_fees ADD COLUMN IF NOT EXISTS manual_email text;

ALTER TABLE public.club_fees DROP CONSTRAINT IF EXISTS club_fees_manual_email_shape;
ALTER TABLE public.club_fees ADD CONSTRAINT club_fees_manual_email_shape CHECK (
  manual_email IS NULL
  OR (
    manual_name IS NOT NULL
    AND player_id IS NULL
    AND fee_type = 'dues'
    AND manual_email = lower(btrim(manual_email))
    AND manual_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    AND char_length(manual_email) <= 254
  )
);

COMMENT ON COLUMN public.club_fees.manual_email IS
  'Optional email on a named (manual) dues payment. A players row created with, or changed to, this email claims the payment (claim_named_fees_for_player). Cleared on claim. Only ever set on a player_id NULL dues row.';

-- One named payment per address per season, the email twin of
-- club_fees_manual_name_season_key: a double-submit must not file it twice.
CREATE UNIQUE INDEX IF NOT EXISTS club_fees_manual_email_season_key
  ON public.club_fees (season_id, lower(manual_email))
  WHERE player_id IS NULL AND fee_type = 'dues' AND manual_email IS NOT NULL;

-- 2. THE CLAIM -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_named_fees_for_player()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.email IS NULL OR btrim(NEW.email) = '' OR NEW.email LIKE '%@deleted.invalid' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.email IS NOT DISTINCT FROM NEW.email THEN
    RETURN NULL;
  END IF;

  BEGIN
    WITH claimable AS (
      SELECT f.id, f.manual_name
        FROM public.club_fees f
       WHERE f.player_id IS NULL
         AND f.fee_type = 'dues'
         AND lower(f.manual_email) = NEW.email
         AND NOT EXISTS (
           SELECT 1 FROM public.club_fees d
            WHERE d.player_id = NEW.id
              AND d.fee_type = 'dues'
              AND d.season_id = f.season_id
         )
       FOR UPDATE
    ), claimed AS (
      UPDATE public.club_fees f
         SET player_id = NEW.id, manual_name = NULL, manual_email = NULL
        FROM claimable c
       WHERE f.id = c.id
      RETURNING f.id, f.season_id, c.manual_name
    )
    INSERT INTO public.audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
    SELECT NULL, 'manual_fee_claimed', 'club_fee', claimed.id,
           jsonb_build_object('manual_name', claimed.manual_name),
           jsonb_build_object('player_id', NEW.id, 'season_id', claimed.season_id),
           'A named payment moved onto the account that signed up with its email'
      FROM claimed;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '00252: could not claim named fees for player %: %', NEW.id, SQLERRM;
  END;

  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.claim_named_fees_for_player() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS claim_named_fees_trg ON public.players;
CREATE TRIGGER claim_named_fees_trg AFTER INSERT OR UPDATE OF email ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.claim_named_fees_for_player();

-- 3. VERIFY --------------------------------------------------------------------
DO $verify$
DECLARE
  v_fn  text := 'public.claim_named_fees_for_player()';
  v_acl text;
  v_def boolean;
  v_cfg text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'club_fees' AND column_name = 'manual_email'
  ) THEN
    RAISE EXCEPTION '00252: club_fees.manual_email is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.club_fees'::regclass AND conname = 'club_fees_manual_email_shape'
  ) THEN
    RAISE EXCEPTION '00252: club_fees_manual_email_shape is missing';
  END IF;
  IF to_regclass('public.club_fees_manual_email_season_key') IS NULL THEN
    RAISE EXCEPTION '00252: club_fees_manual_email_season_key is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.players'::regclass AND tgname = 'claim_named_fees_trg' AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION '00252: claim_named_fees_trg is missing or disabled';
  END IF;

  SELECT prosecdef, proconfig, coalesce(proacl::text, '') INTO v_def, v_cfg, v_acl
    FROM pg_proc WHERE oid = v_fn::regprocedure;
  IF NOT v_def THEN
    RAISE EXCEPTION '00252: % is not SECURITY DEFINER', v_fn;
  END IF;
  IF v_cfg IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_cfg)) THEN
    RAISE EXCEPTION '00252: % has no pinned search_path: %', v_fn, v_cfg;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00252: % is executable by anon or authenticated', v_fn;
  END IF;
  IF v_acl = '' OR v_acl ~ '(^|[{,])=X' THEN
    RAISE EXCEPTION '00252: PUBLIC can execute %: %', v_fn, v_acl;
  END IF;
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';

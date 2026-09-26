-- ============================================================
-- 00253 A RECEIPT SAYS HOW IT WAS PAID
--
-- 00248 let a member upload an Interac e-Transfer receipt, and its confirm
-- wrote method = 'e_transfer' on the fee every time. A membership can also be
-- bought on the SFU Rec website, and that receipt is uploaded the same way. The
-- member is not asked which it is: the browser reads the screenshot and makes a
-- guess, and the exec checks it.
--
-- WHAT THIS FILE ADDS:
--   1. fee_submissions.method: 'e_transfer', 'sfu_rec', or NULL when the
--      browser could not tell. Only dues are sold on the SFU Rec website, so
--      the submit action stores 'e_transfer' for every other line. Set to the
--      method the exec confirmed, on confirm.
--   2. The reference CHECK loosened for an SFU Rec receipt: its number may be
--      as short as 4 characters. An e-transfer stays 6 to 32. The short form is
--      allowed on anything not stored as 'e_transfer', so NULL too: a member
--      whose SFU Rec receipt the browser could not read would otherwise be
--      stuck. That is safe because the method is the browser's word, not a
--      fact, and never was the gate: confirm is. A short reference confirms
--      only as 'sfu_rec', only on dues, and every row before this file holds
--      'e_transfer' through the column default, so NULL means an undetected
--      dues receipt and nothing else.
--   3. review_fee_submission_confirm takes the method. NULL falls back to what
--      the submission carries; a submission that carries none answers
--      'needs_method' and the exec is asked. SFU Rec on anything but dues is
--      'bad_method'; a short reference confirmed as an e-transfer is
--      'short_reference'. The old two-argument call still resolves, through the
--      default, so the console running now keeps working until it is replaced.
--
-- PRECONDITION: 00248 and 00252.
-- ============================================================

BEGIN;

-- 0. PRECONDITION -----------------------------------------------------------
DO $pre$
BEGIN
  IF to_regclass('public.fee_submissions') IS NULL THEN
    RAISE EXCEPTION '00253: apply 00248 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE proname = 'claim_named_fees_for_player'
                    AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION '00253: apply 00252 first';
  END IF;
END
$pre$;

-- 1. THE COLUMN ---------------------------------------------------------------
-- The default is what every row filed before this file was: an e-transfer.
-- The submit action writes the column every time, NULL included.
ALTER TABLE public.fee_submissions ADD COLUMN IF NOT EXISTS method text DEFAULT 'e_transfer';

ALTER TABLE public.fee_submissions DROP CONSTRAINT IF EXISTS fee_submissions_method_check;
ALTER TABLE public.fee_submissions ADD CONSTRAINT fee_submissions_method_check
  CHECK (method IS NULL OR method IN ('e_transfer', 'sfu_rec'));

COMMENT ON COLUMN public.fee_submissions.method IS
  'How the member paid, as detected in their browser from the receipt: a hint the exec checks, NULL when it could not be told. Set to the confirmed method on confirm.';

-- 2. THE REFERENCE --------------------------------------------------------------
-- 00248 declared this inline, so Postgres named it fee_submissions_reference_check.
ALTER TABLE public.fee_submissions DROP CONSTRAINT IF EXISTS fee_submissions_reference_check;
ALTER TABLE public.fee_submissions ADD CONSTRAINT fee_submissions_reference_check CHECK (
  reference ~ '^[A-Za-z0-9-]{6,32}$'
  OR (method IS DISTINCT FROM 'e_transfer' AND reference ~ '^[A-Za-z0-9-]{4,32}$')
);

-- 3. CONFIRM ------------------------------------------------------------------
-- 00248's body with the method threaded through. Dropped first: a new argument
-- is a new overload, and two of them would make the two-argument call ambiguous.
-- The submission is still closed BEFORE the fee is marked paid, for the reason
-- 00248 gives (the supersede trigger).
DROP FUNCTION IF EXISTS public.review_fee_submission_confirm(uuid, uuid);

CREATE OR REPLACE FUNCTION public.review_fee_submission_confirm(
  p_submission_id uuid,
  p_actor uuid,
  p_method text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub    public.fee_submissions%ROWTYPE;
  v_fee    public.club_fees%ROWTYPE;
  v_method text;
BEGIN
  SELECT * INTO v_sub FROM public.fee_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  SELECT * INTO v_fee FROM public.club_fees WHERE id = v_sub.club_fee_id FOR UPDATE;
  IF v_sub.status <> 'submitted' THEN RETURN 'not_pending'; END IF;
  IF v_fee.paid_at IS NOT NULL THEN RETURN 'already_paid'; END IF;
  -- club_fees_settled_has_amount would refuse the update below with a raw 23514.
  IF v_fee.amount_cents IS NULL THEN RETURN 'no_amount'; END IF;

  v_method := coalesce(p_method, v_sub.method);
  IF v_method IS NULL THEN RETURN 'needs_method'; END IF;
  IF v_method NOT IN ('e_transfer', 'sfu_rec') THEN RETURN 'bad_method'; END IF;
  IF v_method = 'sfu_rec' AND v_fee.fee_type <> 'dues' THEN RETURN 'bad_method'; END IF;
  -- A short reference is only allowed on an SFU Rec receipt; the CHECK would
  -- refuse the update below with a raw 23514.
  IF v_sub.reference !~ '^[A-Za-z0-9-]{6,32}$' AND v_method <> 'sfu_rec' THEN
    RETURN 'short_reference';
  END IF;

  UPDATE public.fee_submissions
     SET status = 'confirmed', reviewed_at = now(), reviewed_by = p_actor, method = v_method
   WHERE id = p_submission_id;

  -- The columns markFeePaid writes (apps/admin/src/lib/actions/fees.ts), with
  -- the amount the row already carries.
  UPDATE public.club_fees
     SET paid_at = now(), marked_by = p_actor, method = v_method, reference = v_sub.reference
   WHERE id = v_fee.id;
  RETURN 'ok';
END;
$function$;

REVOKE ALL ON FUNCTION public.review_fee_submission_confirm(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_fee_submission_confirm(uuid, uuid, text) TO service_role;

-- 4. VERIFY ------------------------------------------------------------------
DO $verify$
DECLARE
  v_fn  text := 'public.review_fee_submission_confirm(uuid,uuid,text)';
  v_acl text;
  v_def boolean;
  v_cfg text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'fee_submissions' AND column_name = 'method'
  ) THEN
    RAISE EXCEPTION '00253: fee_submissions.method is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.fee_submissions'::regclass AND conname = 'fee_submissions_method_check'
  ) THEN
    RAISE EXCEPTION '00253: fee_submissions_method_check is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.fee_submissions'::regclass AND conname = 'fee_submissions_reference_check'
       AND position('e_transfer' IN pg_get_constraintdef(oid)) > 0
       AND position('{4,32}' IN pg_get_constraintdef(oid)) > 0
  ) THEN
    RAISE EXCEPTION '00253: fee_submissions_reference_check does not allow a short SFU Rec reference';
  END IF;

  IF (SELECT count(*) FROM pg_proc
       WHERE proname = 'review_fee_submission_confirm' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION '00253: expected exactly one review_fee_submission_confirm';
  END IF;
  IF (SELECT pg_get_function_identity_arguments(oid) FROM pg_proc
       WHERE proname = 'review_fee_submission_confirm' AND pronamespace = 'public'::regnamespace)
     <> 'p_submission_id uuid, p_actor uuid, p_method text' THEN
    RAISE EXCEPTION '00253: review_fee_submission_confirm does not take the method';
  END IF;

  SELECT prosecdef, proconfig, coalesce(proacl::text, '') INTO v_def, v_cfg, v_acl
    FROM pg_proc WHERE oid = v_fn::regprocedure;
  IF NOT v_def THEN
    RAISE EXCEPTION '00253: % is not SECURITY DEFINER', v_fn;
  END IF;
  IF v_cfg IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_cfg)) THEN
    RAISE EXCEPTION '00253: % has no pinned search_path: %', v_fn, v_cfg;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00253: % is executable by anon or authenticated', v_fn;
  END IF;
  IF v_acl = '' OR v_acl ~ '(^|[{,])=X' THEN
    RAISE EXCEPTION '00253: PUBLIC can execute %: %', v_fn, v_acl;
  END IF;
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00253: service_role cannot execute %', v_fn;
  END IF;
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';

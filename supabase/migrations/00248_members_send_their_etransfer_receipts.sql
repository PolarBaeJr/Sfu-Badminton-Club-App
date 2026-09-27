-- ============================================================
-- 00248 MEMBERS SEND THEIR E-TRANSFER RECEIPTS
--
-- A member pays a fee by Interac e-Transfer, then uploads a screenshot of the
-- confirmation and types (or has read off the image) the reference number. An
-- exec checks it against the club's bank and confirms or rejects it. Until now
-- the only way a payment reached the books was an exec typing it in.
--
-- WHAT THIS FILE ADDS:
--   1. club_fees learns a fourth kind of row, 'event': the cost of a club event
--      (00244), filed by a trigger when a member signs up and removed when they
--      withdraw, unless a receipt is already in for it. Plus
--      payment_reminded_at, stamped when an exec sends a "please pay" nudge.
--   2. fee_submissions: one row per receipt sent. Members read their own; every
--      write is the service role (the player app's submit action, and the two
--      review RPCs below).
--   3. The private fee-proofs bucket, same shape as 00174 and 00231: a member
--      uploads into a folder named after their auth uid, and nothing else.
--   4. review_fee_submission_confirm / _reject, service role only. Confirm
--      marks the fee paid by e-transfer with the member's reference, in the
--      same transaction that closes the submission.
--   5. A trigger that marks a waiting submission superseded when the fee is
--      settled some other way (an exec records cash, or waives it).
--   6. player_season_paid(): a yes/no for the "Paid" badge on a member's
--      profile, for signed-in members, never an amount.
--   7. The merge guard told about fee_submissions.reviewed_by.
--
-- fee_submissions.player_id HAS NO FOREIGN KEY TO players, on purpose. It rides
-- on the composite key (club_fee_id, player_id) into club_fees, ON UPDATE
-- CASCADE: merge_players repoints club_fees.player_id and the submissions move
-- with their fee. A direct key would be one more column for the merge guard to
-- classify, and one that could disagree with the fee it belongs to.
--
-- REQUIRES 00247 APPLIED FIRST (it restates nothing of 00247's, but it is the
-- file before this one and the staging replay applies them in order).
--
-- STAGING: like 00244, until prod has this file the nightly snapshot replays it
-- against prod-state data and the new table is recreated EMPTY every night.
-- ============================================================

BEGIN;

-- 0. PRECONDITION: 00247 ----------------------------------------------------
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'players_permission_vocabulary_check'
                    AND position('''page.access.membership''' IN pg_get_constraintdef(oid)) > 0) THEN
    RAISE EXCEPTION '00248: apply 00247 first, the vocabulary does not know page.access.membership';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.merge_players_disposable()
                  WHERE tbl = 'club_events' AND col = 'created_by') THEN
    RAISE EXCEPTION '00248: apply 00244 first, merge_players_disposable() does not have its rows';
  END IF;
END
$pre$;

-- 1. club_fees: THE 'event' KIND ---------------------------------------------
ALTER TABLE public.club_fees
  ADD COLUMN IF NOT EXISTS club_event_id uuid REFERENCES public.club_events(id) ON DELETE RESTRICT;
ALTER TABLE public.club_fees
  ADD COLUMN IF NOT EXISTS payment_reminded_at timestamptz;

ALTER TABLE public.club_fees DROP CONSTRAINT IF EXISTS club_fees_fee_type_check;
ALTER TABLE public.club_fees ADD CONSTRAINT club_fees_fee_type_check
  CHECK (fee_type IN ('dues', 'tournament', 'reinstatement', 'event'));

-- The three existing arms verbatim, each with club_event_id IS NULL added, and
-- the event arm shaped like the tournament one: a real player, nothing of the
-- other kinds. season_id is left free: the trigger stamps the active season,
-- and between seasons there is none.
ALTER TABLE public.club_fees DROP CONSTRAINT IF EXISTS club_fees_shape_check;
ALTER TABLE public.club_fees ADD CONSTRAINT club_fees_shape_check CHECK (
  CASE fee_type
    WHEN 'dues' THEN season_id IS NOT NULL AND tournament_id IS NULL AND tier_id IS NULL
                     AND ban_started_at IS NULL AND ban_reason IS NULL AND club_event_id IS NULL
    WHEN 'tournament' THEN tournament_id IS NOT NULL AND manual_name IS NULL
                     AND ban_started_at IS NULL AND ban_reason IS NULL AND club_event_id IS NULL
    WHEN 'reinstatement' THEN ban_started_at IS NOT NULL AND manual_name IS NULL
                     AND tournament_id IS NULL AND tier_id IS NULL AND club_event_id IS NULL
    WHEN 'event' THEN club_event_id IS NOT NULL AND player_id IS NOT NULL AND manual_name IS NULL
                     AND tournament_id IS NULL AND tier_id IS NULL
                     AND ban_started_at IS NULL AND ban_reason IS NULL
    ELSE FALSE
  END
);

CREATE UNIQUE INDEX IF NOT EXISTS club_fees_event_player_key
  ON public.club_fees (club_event_id, player_id) WHERE fee_type = 'event';

-- The target of fee_submissions' composite key. id alone is already unique, so
-- this admits nothing new; it exists so the pair can be referenced.
-- Added only when absent: once fee_submissions references it, it cannot be
-- dropped and re-added.
DO $key$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'club_fees_id_player_key') THEN
    ALTER TABLE public.club_fees ADD CONSTRAINT club_fees_id_player_key UNIQUE (id, player_id);
  END IF;
END
$key$;

-- 2. fee_submissions ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fee_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_fee_id     uuid NOT NULL,
  player_id       uuid NOT NULL,
  reference       text NOT NULL CHECK (reference ~ '^[A-Za-z0-9-]{6,32}$'),
  -- Nulled when the account is purged; the row stays as the club's record.
  screenshot_path text,
  status          text NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted', 'confirmed', 'rejected', 'superseded')),
  reject_reason   text CHECK (reject_reason IS NULL OR char_length(reject_reason) BETWEEN 3 AND 500),
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at     timestamptz,
  reviewed_by     uuid REFERENCES public.players(id) ON DELETE SET NULL,
  CONSTRAINT fee_submissions_fee_fkey FOREIGN KEY (club_fee_id, player_id)
    REFERENCES public.club_fees (id, player_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fee_submissions_rejected_has_reason CHECK (status <> 'rejected' OR reject_reason IS NOT NULL),
  CONSTRAINT fee_submissions_reviewed_has_time CHECK (status NOT IN ('confirmed', 'rejected') OR reviewed_at IS NOT NULL),
  CONSTRAINT fee_submissions_pending_unreviewed CHECK (status <> 'submitted' OR reviewed_at IS NULL)
);

-- At most one receipt waiting per fee. The submit action maps the violation to
-- "You already have a submission waiting".
CREATE UNIQUE INDEX IF NOT EXISTS fee_submissions_one_pending
  ON public.fee_submissions (club_fee_id) WHERE status = 'submitted';
CREATE INDEX IF NOT EXISTS fee_submissions_player_idx ON public.fee_submissions (player_id);
CREATE INDEX IF NOT EXISTS fee_submissions_status_idx ON public.fee_submissions (status, submitted_at);

-- 3. GRANTS AND RLS ---------------------------------------------------------
-- Supabase default privileges give anon and authenticated everything on a new
-- table, so both are revoked and SELECT is handed back to members only. No
-- write policy and no write grant: every write is the service role.
ALTER TABLE public.fee_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fee_submissions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.fee_submissions TO authenticated;
GRANT ALL    ON TABLE public.fee_submissions TO service_role;

DROP POLICY IF EXISTS fee_submissions_select_own ON public.fee_submissions;
CREATE POLICY fee_submissions_select_own ON public.fee_submissions
  FOR SELECT TO authenticated
  USING (player_id = public.get_player_id(auth.uid()));

-- 4. THE fee-proofs BUCKET ------------------------------------------------------
-- 00174's shape. Private, 8 MiB, three image types, and one policy: a member
-- may upload into their own folder. No SELECT, UPDATE or DELETE policy, so
-- nobody but the service role can list, read, overwrite or remove an object;
-- the console signs a 60-second URL on demand.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'fee-proofs',
  'fee-proofs',
  FALSE,
  8388608,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS fee_proofs_auth_insert ON storage.objects;
CREATE POLICY fee_proofs_auth_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'fee-proofs'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- 5. REVIEW RPCs ----------------------------------------------------------------
-- The submission first, then the fee, both locked, so a confirm and a reject
-- racing on one receipt serialise, and an exec marking the fee paid by hand at
-- the same moment queues behind the fee lock.
--
-- The submission is closed BEFORE the fee is marked paid: the supersede trigger
-- (section 7) fires on that UPDATE of paid_at and would otherwise mark this very
-- submission superseded.
CREATE OR REPLACE FUNCTION public.review_fee_submission_confirm(p_submission_id uuid, p_actor uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub public.fee_submissions%ROWTYPE;
  v_fee public.club_fees%ROWTYPE;
BEGIN
  SELECT * INTO v_sub FROM public.fee_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  SELECT * INTO v_fee FROM public.club_fees WHERE id = v_sub.club_fee_id FOR UPDATE;
  IF v_sub.status <> 'submitted' THEN RETURN 'not_pending'; END IF;
  IF v_fee.paid_at IS NOT NULL THEN RETURN 'already_paid'; END IF;
  -- club_fees_settled_has_amount would refuse the update below with a raw 23514.
  IF v_fee.amount_cents IS NULL THEN RETURN 'no_amount'; END IF;

  UPDATE public.fee_submissions
     SET status = 'confirmed', reviewed_at = now(), reviewed_by = p_actor
   WHERE id = p_submission_id;

  -- The columns markFeePaid writes (apps/admin/src/lib/actions/fees.ts), with
  -- the amount the row already carries.
  UPDATE public.club_fees
     SET paid_at = now(), marked_by = p_actor, method = 'e_transfer', reference = v_sub.reference
   WHERE id = v_fee.id;
  RETURN 'ok';
END;
$function$;

CREATE OR REPLACE FUNCTION public.review_fee_submission_reject(p_submission_id uuid, p_actor uuid, p_reason text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub public.fee_submissions%ROWTYPE;
BEGIN
  SELECT * INTO v_sub FROM public.fee_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  PERFORM 1 FROM public.club_fees WHERE id = v_sub.club_fee_id FOR UPDATE;
  IF v_sub.status <> 'submitted' THEN RETURN 'not_pending'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RETURN 'bad_reason';
  END IF;

  UPDATE public.fee_submissions
     SET status = 'rejected', reject_reason = btrim(p_reason), reviewed_at = now(), reviewed_by = p_actor
   WHERE id = p_submission_id;
  RETURN 'ok';
END;
$function$;

REVOKE ALL ON FUNCTION public.review_fee_submission_confirm(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.review_fee_submission_reject(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_fee_submission_confirm(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_fee_submission_reject(uuid, uuid, text) TO service_role;

-- 6. EVENT FEES FOLLOW SIGN-UPS ---------------------------------------------------
-- Priced at sign-up: a later edit of the event's cost does not re-price anybody
-- already in. Execs and fee-exempt members are not charged, the rule
-- ensureEntryFees applies to tournament entries.
CREATE OR REPLACE FUNCTION public.club_event_signup_fee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cost   integer;
  v_exempt boolean;
BEGIN
  SELECT cost_cents INTO v_cost FROM public.club_events WHERE id = NEW.event_id;
  IF v_cost IS NULL OR v_cost = 0 THEN RETURN NULL; END IF;
  SELECT (coalesce(is_exec, FALSE) OR coalesce(fee_exempt, FALSE)) INTO v_exempt
    FROM public.players WHERE id = NEW.player_id;
  IF v_exempt IS DISTINCT FROM FALSE THEN RETURN NULL; END IF;

  INSERT INTO public.club_fees (fee_type, club_event_id, player_id, amount_cents, season_id)
  VALUES ('event', NEW.event_id, NEW.player_id, v_cost,
          (SELECT id FROM public.seasons WHERE active_flag = TRUE LIMIT 1))
  ON CONFLICT (club_event_id, player_id) WHERE fee_type = 'event' DO NOTHING;
  RETURN NULL;
END;
$function$;

-- A withdrawal takes the unpaid fee with it, unless a receipt is waiting on it
-- or was confirmed: money that may have moved is an exec's call, and the
-- console marks the row as withdrawn.
CREATE OR REPLACE FUNCTION public.club_event_withdraw_fee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM public.club_fees f
   WHERE f.fee_type = 'event'
     AND f.club_event_id = OLD.event_id
     AND f.player_id = OLD.player_id
     AND f.paid_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.fee_submissions s
                      WHERE s.club_fee_id = f.id AND s.status IN ('submitted', 'confirmed'));
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_signup_fee() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_event_withdraw_fee() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS club_event_signup_fee ON public.club_event_signups;
CREATE TRIGGER club_event_signup_fee AFTER INSERT ON public.club_event_signups
  FOR EACH ROW EXECUTE FUNCTION public.club_event_signup_fee();
DROP TRIGGER IF EXISTS club_event_withdraw_fee ON public.club_event_signups;
CREATE TRIGGER club_event_withdraw_fee AFTER DELETE ON public.club_event_signups
  FOR EACH ROW EXECUTE FUNCTION public.club_event_withdraw_fee();

-- 7. SETTLED ANOTHER WAY --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fee_submissions_supersede()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.fee_submissions
     SET status = 'superseded', reviewed_at = now()
   WHERE club_fee_id = NEW.id AND status = 'submitted';
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fee_submissions_supersede() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS fee_submissions_supersede ON public.club_fees;
CREATE TRIGGER fee_submissions_supersede AFTER UPDATE OF paid_at ON public.club_fees
  FOR EACH ROW WHEN (OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL)
  EXECUTE FUNCTION public.fee_submissions_supersede();

-- 7b. THE PUBLIC "PAID" BADGE ---------------------------------------------------
-- club_fees RLS lets a member read only their own rows, so a badge on SOMEBODY
-- ELSE's profile needs a read that answers one question and nothing more: has
-- this member paid this season's dues. A boolean, never an amount or a method.
-- False for a waiver, for an exec or fee-exempt member (never billed), for an
-- unpaid member, and between seasons. Signed-in members only: anon is refused.
CREATE OR REPLACE FUNCTION public.player_season_paid(p_player_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.club_fees f
      JOIN public.seasons s ON s.id = f.season_id AND s.active_flag = TRUE
      JOIN public.players p ON p.id = f.player_id
     WHERE f.player_id = p_player_id
       AND f.fee_type = 'dues'
       AND f.paid_at IS NOT NULL
       AND lower(btrim(coalesce(f.method, ''))) <> 'waived'
       AND NOT coalesce(p.is_exec, FALSE)
       AND NOT coalesce(p.fee_exempt, FALSE)
  );
$function$;
REVOKE ALL ON FUNCTION public.player_season_paid(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.player_season_paid(uuid) TO authenticated, service_role;

-- 8. MERGE GUARD ---------------------------------------------------------------
-- fee_submissions.reviewed_by is a new reference to players, so it must be
-- classified or every merge is refused. Disposable: the removed account's
-- DELETE runs SET NULL, and the audit row for the review keeps the actor.
-- The eleven rows are 00244's, verbatim.
CREATE OR REPLACE FUNCTION public.merge_players_disposable()
 RETURNS TABLE(tbl text, col text)
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT * FROM (VALUES
    ('notifications',        'player_id'),
    ('push_subscriptions',   'player_id'),
    ('calendar_feed_tokens', 'player_id'),
    ('ratings',              'player_id'),
    ('reliability_metrics',  'player_id'),
    ('discord_outbox',       'requested_by'),
    ('data_api_consumers',   'created_by'),
    ('data_api_keys',        'minted_by'),
    ('data_api_keys',        'revoked_by'),
    ('club_event_signups',   'player_id'),
    ('club_events',          'created_by'),
    ('fee_submissions',      'reviewed_by')
  ) AS t(tbl, col);
$function$;
REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;

-- 9. VERIFY ------------------------------------------------------------------
DO $verify$
DECLARE
  v_fn  text;
  v_gap text;
  v_acl text;
BEGIN
  -- anon absent from the table's ACL; authenticated holds SELECT and nothing
  -- else. relacl, not information_schema, which reports grants that do not exist.
  SELECT relacl::text INTO v_acl FROM pg_class WHERE oid = 'public.fee_submissions'::regclass;
  IF v_acl ~ '(^|[{,])anon=' OR v_acl ~ '(^|[{,])=' THEN
    RAISE EXCEPTION '00248: anon or PUBLIC holds a grant on fee_submissions: %', v_acl;
  END IF;
  IF v_acl !~ '(^|[{,])authenticated=r/' THEN
    RAISE EXCEPTION '00248: authenticated should hold SELECT only on fee_submissions: %', v_acl;
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.fee_submissions'::regclass) THEN
    RAISE EXCEPTION '00248: RLS is not enabled on fee_submissions';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fee_submissions'
              AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION '00248: fee_submissions has a write policy';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY['public.review_fee_submission_confirm(uuid,uuid)',
                              'public.review_fee_submission_reject(uuid,uuid,text)',
                              'public.club_event_signup_fee()',
                              'public.club_event_withdraw_fee()',
                              'public.fee_submissions_supersede()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00248: % is executable by anon or authenticated', v_fn;
    END IF;
    SELECT coalesce(proacl::text, '') INTO v_acl FROM pg_proc WHERE oid = v_fn::regprocedure;
    IF v_acl = '' OR v_acl ~ '(^|[{,])=X' THEN
      RAISE EXCEPTION '00248: PUBLIC can execute %: %', v_fn, v_acl;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.review_fee_submission_confirm(uuid,uuid)',
                              'public.review_fee_submission_reject(uuid,uuid,text)'] LOOP
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00248: service_role cannot execute %', v_fn;
    END IF;
  END LOOP;

  -- The badge: members yes, anon and PUBLIC no.
  IF has_function_privilege('anon', 'public.player_season_paid(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.player_season_paid(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00248: player_season_paid should be executable by authenticated and not anon';
  END IF;
  SELECT coalesce(proacl::text, '') INTO v_acl FROM pg_proc
   WHERE oid = 'public.player_season_paid(uuid)'::regprocedure;
  IF v_acl = '' OR v_acl ~ '(^|[{,])=X' THEN
    RAISE EXCEPTION '00248: PUBLIC can execute player_season_paid: %', v_acl;
  END IF;

  -- The bucket: private, 8 MiB, three types, and one policy that names it.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets
                  WHERE id = 'fee-proofs' AND public = FALSE AND file_size_limit = 8388608
                    AND allowed_mime_types @> ARRAY['image/jpeg','image/png','image/webp']
                    AND cardinality(allowed_mime_types) = 3) THEN
    RAISE EXCEPTION '00248: the fee-proofs bucket is not private, 8 MiB, three image types';
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND (coalesce(qual, '') LIKE '%fee-proofs%' OR coalesce(with_check, '') LIKE '%fee-proofs%')) <> 1 THEN
    RAISE EXCEPTION '00248: expected exactly one storage policy naming fee-proofs';
  END IF;

  -- The composite key carries a merge's repoint to the submissions.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'fee_submissions_fee_fkey'
                    AND confupdtype = 'c' AND confdeltype = 'c') THEN
    RAISE EXCEPTION '00248: fee_submissions_fee_fkey is not ON UPDATE CASCADE ON DELETE CASCADE';
  END IF;

  SELECT string_agg(format('%s.%s', tbl, col), ', ') INTO v_gap
    FROM public.merge_players_unhandled();
  IF v_gap IS NOT NULL THEN
    RAISE EXCEPTION '00248: merges would be refused, unclassified: %', v_gap;
  END IF;
  IF (SELECT count(*) FROM public.merge_players_disposable()) <> 12 THEN
    RAISE EXCEPTION '00248: merge_players_disposable is not the twelve rows';
  END IF;
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';

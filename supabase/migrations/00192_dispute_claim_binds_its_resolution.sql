-- 00192 — a dispute claim binds the resolution it was taken for (F-002 residual)
--
-- WHAT WAS STILL OPEN AFTER 00178 AND 00188
--
-- The rated branch of resolveDispute has been one transaction since 00178:
-- resolve_dispute_rated locks the dispute, refuses a resolved one, applies the
-- result once and closes the dispute together. Nothing below changes it.
--
-- The unrated branch — Void and Convert to casual — is still three steps in the
-- application: claim the dispute, mutate the match, close the dispute. 00188
-- fixed the claim so two admins cannot hold it at once. What it did not fix is
-- that the claim says WHO is resolving and never says WHAT they are resolving
-- it as, and the failure that matters lands between step two and step three:
--
--   1. An admin resolves dispute D as converted_to_casual.
--   2. convertMatchToCasual(M) commits. M is now a casual match.
--   3. The close UPDATE fails, or its response is lost. D is still under_review.
--   4. The admin retries — and this time chooses Void.
--   5. The claim is re-granted (same actor, or the 15 minute TTL has lapsed and
--      a different admin picks it up), and voidMatch(M) runs.
--
-- voidMatch has no precondition on the match's current classification: it sets
-- result_status = 'voided' outright. So a match that one resolution already
-- reclassified as casual is silently re-reclassified as void, and the club's
-- record of what happened to that match is now whichever attempt ran last.
-- Neither of the two mutations doubles a rating, which is why this survived the
-- SEV-1 sweep, but "the match ends up in a state no admin chose" is a defect on
-- its own terms.
--
-- THE FIX, AND WHY IT IS THE CLAIM RATHER THAN A SECOND MARKER
--
-- The obvious alternative is to stamp the dispute with the resolution actually
-- applied, after the match mutation succeeds and before the close. That trades
-- one window for a smaller one — the stamp can fail too — and leaves the same
-- shape of bug behind. Recording the INTENT at claim time has no window at all,
-- because the claim and the intent are the same statement.
--
-- So the claim now carries the resolution it was taken for, and a claim for a
-- resolution different from the one already recorded is refused. A retry of the
-- SAME resolution still proceeds, which is what makes an ordinary retry work:
-- both mutations are idempotent for their own type, so re-running one is
-- harmless, and the close is what finally ends the dispute.
--
-- The cost is one false refusal: an admin who claims as Void, suffers a failure
-- before anything is applied, and then changes their mind to Convert to casual
-- is told no. That only ever happens on a dispute that has ALREADY failed
-- mid-resolution — the happy path closes the dispute and the recorded intent
-- becomes moot — so the case where the block bites is exactly the case where
-- refusing to guess is right. The error names the recorded resolution so the
-- operator can see what the earlier attempt was doing.
--
-- WHAT THIS DOES NOT CLAIM
--
-- It does not make the unrated branch one transaction. The match mutation still
-- commits separately from the close, so a failure between them still leaves a
-- dispute open against an already-mutated match; the operator resolves it by
-- retrying the same resolution, which is now the only one it will accept. The
-- register's preferred remedy — a single RPC that voids or reclassifies the
-- match and closes the dispute together — would need voidMatch's Elo reversal,
-- match-note write and audit row to move into SQL, and that is a larger change
-- than this one. This closes the divergent-outcome defect, not the atomicity.

BEGIN;

-- Nullable and unconstrained by design: every dispute predating this migration
-- has no recorded intent, which reads correctly as "nothing has claimed this
-- for a particular resolution yet".
ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS claimed_resolution_type public.dispute_resolution;

COMMENT ON COLUMN public.disputes.claimed_resolution_type IS
  'The resolution the live claim was taken for. Set by claim_dispute_for_resolution and never cleared: it is what stops a retry applying a different, conflicting match mutation (00192).';

-- The two-argument form has to go rather than sit alongside, because a call
-- that omits the new argument would otherwise bind to it exactly and get an
-- unfenced claim — the same trap 00188 closed by dropping the one-argument
-- form. With it gone, an old caller's two-argument call resolves to the new
-- function through the default and is refused by the NULL check below, which
-- is a readable error rather than "function does not exist".
DROP FUNCTION IF EXISTS public.claim_dispute_for_resolution(uuid, uuid);

CREATE OR REPLACE FUNCTION public.claim_dispute_for_resolution(
  p_dispute_id      uuid,
  p_actor_id        uuid,
  p_resolution_type public.dispute_resolution DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_dispute disputes;
  v_claim_ttl CONSTANT interval := INTERVAL '15 minutes';
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'claim_dispute_for_resolution requires an actor';
  END IF;

  -- A caller that does not say what it is resolving the dispute AS cannot be
  -- fenced, so it does not get a claim. This is the branch an application still
  -- running the pre-00192 image lands on.
  IF p_resolution_type IS NULL THEN
    RAISE EXCEPTION 'claim_dispute_for_resolution requires the resolution it is being claimed for';
  END IF;

  -- accepted and edited are the rated branch; they go through
  -- resolve_dispute_rated, which does its own locking and closing in one
  -- transaction. Reaching this function with one of them means a caller has
  -- taken the wrong branch, and granting the claim would let it resolve a
  -- rated dispute without ever applying the result.
  IF p_resolution_type NOT IN ('voided', 'converted_to_casual') THEN
    RAISE EXCEPTION 'claim_dispute_for_resolution only serves voided and converted_to_casual, not %', p_resolution_type;
  END IF;

  SELECT * INTO v_dispute FROM disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_dispute IS NULL THEN
    RAISE EXCEPTION 'Dispute not found';
  END IF;

  IF v_dispute.status = 'resolved' THEN
    RETURN jsonb_build_object(
      'claimed', false, 'already_resolved', true, 'held_by_other', false,
      'type_conflict', false, 'claimed_resolution_type', v_dispute.claimed_resolution_type,
      'match_id', v_dispute.match_id
    );
  END IF;

  IF v_dispute.claimed_by IS NOT NULL
     AND v_dispute.claimed_by <> p_actor_id
     AND v_dispute.claimed_at IS NOT NULL
     AND v_dispute.claimed_at > NOW() - v_claim_ttl THEN
    RETURN jsonb_build_object(
      'claimed', false, 'already_resolved', false, 'held_by_other', true,
      'type_conflict', false, 'claimed_resolution_type', v_dispute.claimed_resolution_type,
      'match_id', v_dispute.match_id
    );
  END IF;

  -- The new fence, and note where it sits: AFTER the resolved and held_by_other
  -- checks, so those keep their existing meanings, and BEFORE the claim is
  -- granted, so a conflicting attempt never gets one. It deliberately outlives
  -- the claim TTL — an expired claim still leaves the recorded intent, because
  -- the match mutation it may have applied has not expired.
  IF v_dispute.claimed_resolution_type IS NOT NULL
     AND v_dispute.claimed_resolution_type <> p_resolution_type THEN
    RETURN jsonb_build_object(
      'claimed', false, 'already_resolved', false, 'held_by_other', false,
      'type_conflict', true, 'claimed_resolution_type', v_dispute.claimed_resolution_type,
      'match_id', v_dispute.match_id
    );
  END IF;

  UPDATE disputes
     SET status                  = 'under_review',
         claimed_by              = p_actor_id,
         claimed_at              = NOW(),
         claimed_resolution_type = p_resolution_type,
         updated_at              = NOW()
   WHERE id = p_dispute_id;

  RETURN jsonb_build_object(
    'claimed', true, 'already_resolved', false, 'held_by_other', false,
    'type_conflict', false, 'claimed_resolution_type', p_resolution_type,
    'match_id', v_dispute.match_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_dispute_for_resolution(uuid, uuid, public.dispute_resolution) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_dispute_for_resolution(uuid, uuid, public.dispute_resolution) TO service_role;

DO $verify$
DECLARE
  v_bad TEXT[] := ARRAY[]::TEXT[];
  v_oid oid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='disputes'
                    AND column_name='claimed_resolution_type') THEN
    v_bad := array_append(v_bad, 'disputes.claimed_resolution_type missing');
  END IF;

  -- to_regprocedure, NOT pg_get_function_identity_arguments. That function
  -- returns "p_dispute_id uuid, p_actor_id uuid" — argument NAMES included —
  -- so the type-only string these assertions used to compare against could
  -- never match. Both "old signature still exists" checks in 00188 are vacuous
  -- for exactly that reason and assert nothing today. to_regprocedure resolves
  -- a signature to an oid or NULL and does not care what the parameters are
  -- called. It is given a NULL-safe cast because an unknown signature raises
  -- rather than returning NULL when written as a regprocedure literal.
  IF to_regprocedure('public.claim_dispute_for_resolution(uuid,uuid)') IS NOT NULL THEN
    v_bad := array_append(v_bad, 'claim_dispute_for_resolution(uuid,uuid) still exists');
  END IF;

  v_oid := to_regprocedure('public.claim_dispute_for_resolution(uuid,uuid,public.dispute_resolution)');
  IF v_oid IS NULL THEN
    v_bad := array_append(v_bad, 'claim_dispute_for_resolution(uuid,uuid,dispute_resolution) missing');
  ELSE
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'claim_dispute_for_resolution: anon can execute');
    END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'claim_dispute_for_resolution: authenticated can execute');
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'claim_dispute_for_resolution: service_role CANNOT execute');
    END IF;
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION '00192 verification failed: %', array_to_string(v_bad, '; ');
  END IF;

  RAISE NOTICE '00192: the dispute claim now binds the resolution it was taken for.';
END
$verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;

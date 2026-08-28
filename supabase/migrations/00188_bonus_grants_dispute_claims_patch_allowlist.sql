-- 00188_bonus_grants_dispute_claims_patch_allowlist.sql
--
-- Four defects the 00177-00187 pass left behind, all of the same family: a
-- guard that lives in the application when the database is the only place it
-- can actually hold.
--
--   F-003  The placement-bonus idempotence ledger is a row written AFTER the
--          bonuses. Two finalise runs both read an empty ledger, both pay.
--   F-002  claim_dispute_for_resolution treats an already-claimed dispute as
--          claimable, so the "claim" excludes nobody.
--   F-025  issue_passkey_challenge can clear consumed_at, un-spending a
--          challenge that was already spent.
--   F-017  merge_my_notification_preferences merges any key the caller sends.
--          It is authenticated-callable, so the SQL is the trust boundary and
--          the application allowlist is decoration.

BEGIN;

-- ===========================================================================
-- F-003. The bonus ledger becomes a uniqueness constraint.
-- ===========================================================================
--
-- The ledger was a tournament_audit_log row written after every bonus in the
-- batch had already landed. Read-then-pay-then-record is the classic
-- check-then-act: two operators pressing the button at once, or one retrying
-- through a proxy timeout, both read a ledger with no rows in it and both pay
-- the whole podium. The window is the entire duration of the batch.
--
-- A ledger cannot fix that no matter where it is written, because the read and
-- the write are two statements. What fixes it is making the grant itself the
-- thing that is unique: the payment and the record of the payment become one
-- INSERT, and the second caller loses the race on an index rather than on a
-- comparison it made a second ago.
--
-- ON CONFLICT DO NOTHING is doing real concurrency work here, not tidying up.
-- The loser of the race BLOCKS on the unique index until the winner commits,
-- then sees the conflict — so it cannot observe a half-applied state, and it
-- reports already_granted rather than paying.
--
-- Kept separate per kind because singles has two non-idempotent writes per
-- player (the rating, and the participant's recorded elo_change) which fail
-- independently, exactly as the old two-set ledger tracked them.
CREATE TABLE IF NOT EXISTS public.tournament_bonus_grants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES public.tournament_events(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('rating', 'participant_credit')),
  -- players.id for a 'rating' grant, tournament_participants.id for a
  -- 'participant_credit' one. Deliberately not a foreign key: the two kinds
  -- point at different tables and the row must outlive neither.
  subject_id       uuid NOT NULL,
  discipline       text CHECK (discipline IN ('singles', 'doubles')),
  requested_bonus  integer NOT NULL,
  -- What actually landed after the clamp. A player already at max_elo gets 0,
  -- which is the honest answer and still counts as settled.
  applied_delta    integer NOT NULL DEFAULT 0,
  granted_at       timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, kind, subject_id)
);

ALTER TABLE public.tournament_bonus_grants ENABLE ROW LEVEL SECURITY;
-- No policies. Every access is through the two SECURITY DEFINER functions
-- below; there is nothing here a member should read.

-- BACKFILL. Events finalised before this migration recorded their grants in
-- tournament_audit_log.details, and that record is the only thing standing
-- between them and a second payment. Bring it across before the new functions
-- can be called, or the first retry on an old event pays it twice.
--
-- applied_delta is 0 because the old ledger never recorded what landed, only
-- who was paid. That is the honest value: these rows exist to block a repeat,
-- not to report an amount.
INSERT INTO public.tournament_bonus_grants (event_id, kind, subject_id, requested_bonus, applied_delta, granted_at)
SELECT l.event_id, 'rating', s.subject::uuid, 0, 0, l.created_at
  FROM public.tournament_audit_log l
 CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(l.details -> 'rated_players', '[]'::jsonb)) AS s(subject)
 WHERE l.action = 'placement_bonuses_applied' AND l.event_id IS NOT NULL
ON CONFLICT (event_id, kind, subject_id) DO NOTHING;

INSERT INTO public.tournament_bonus_grants (event_id, kind, subject_id, requested_bonus, applied_delta, granted_at)
SELECT l.event_id, 'participant_credit', s.subject::uuid, 0, 0, l.created_at
  FROM public.tournament_audit_log l
 CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(l.details -> 'credited_participants', '[]'::jsonb)) AS s(subject)
 WHERE l.action = 'placement_bonuses_applied' AND l.event_id IS NOT NULL
ON CONFLICT (event_id, kind, subject_id) DO NOTHING;

-- The three-argument form had no event to key the grant on, so it goes. A
-- caller left on the old signature must fail loudly rather than silently
-- paying an unledgered bonus.
DROP FUNCTION IF EXISTS public.apply_placement_bonus(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.apply_placement_bonus(
  p_event_id   uuid,
  p_player_id  uuid,
  p_discipline text,
  p_bonus      integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_elo_field TEXT;
  v_lo INTEGER;
  v_hi INTEGER;
  v_old INTEGER;
  v_new INTEGER;
BEGIN
  IF p_discipline NOT IN ('singles', 'doubles') THEN
    RAISE EXCEPTION 'invalid discipline: %', p_discipline;
  END IF;
  v_elo_field := CASE WHEN p_discipline = 'singles' THEN 'singles_elo' ELSE 'doubles_elo' END;

  -- CLAIM FIRST, PAY SECOND. Everything below this INSERT runs at most once
  -- per (event, player) for all time, across every concurrent caller.
  INSERT INTO tournament_bonus_grants (event_id, kind, subject_id, discipline, requested_bonus)
  VALUES (p_event_id, 'rating', p_player_id, p_discipline, COALESCE(p_bonus, 0))
  ON CONFLICT (event_id, kind, subject_id) DO NOTHING;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'already_granted', true, 'applied_delta', 0);
  END IF;

  -- FOR UPDATE is the other half: the grant makes it happen once, the lock
  -- makes the arithmetic a delta rather than an absolute written over whatever
  -- moved in between.
  EXECUTE format('SELECT %I FROM ratings WHERE player_id = $1 FOR UPDATE', v_elo_field)
    INTO v_old USING p_player_id;

  -- NOT 400. A player with no ratings row is an integrity problem; inventing a
  -- starting rating and adding a podium bonus to it writes a number nobody can
  -- distinguish from a real one afterwards. The RAISE rolls back the grant with
  -- it, so the retry after the data is fixed still pays.
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'No ratings row for player % — cannot award a placement bonus', p_player_id;
  END IF;

  SELECT lo, hi INTO v_lo, v_hi FROM rating_bounds();
  v_new := LEAST(GREATEST(v_old + COALESCE(p_bonus, 0), v_lo), v_hi);

  EXECUTE format('UPDATE ratings SET %I = $1, updated_at = NOW() WHERE player_id = $2', v_elo_field)
    USING v_new, p_player_id;

  UPDATE tournament_bonus_grants
     SET applied_delta = v_new - v_old
   WHERE event_id = p_event_id AND kind = 'rating' AND subject_id = p_player_id;

  RETURN jsonb_build_object(
    'applied', true, 'already_granted', false,
    'new_elo', v_new, 'applied_delta', v_new - v_old
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_placement_bonus(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_placement_bonus(uuid, uuid, text, integer) TO service_role;

-- The participant's recorded elo_change is the second non-idempotent write of
-- the pair, and it was a read-modify-write issued from the application with the
-- same check-then-act shape. Same grant, same lock, same guarantee.
CREATE OR REPLACE FUNCTION public.credit_participant_placement_bonus(
  p_event_id       uuid,
  p_participant_id uuid,
  p_bonus          integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_lo INTEGER;
  v_hi INTEGER;
  v_change INTEGER;
  v_after INTEGER;
  v_new_after INTEGER;
BEGIN
  INSERT INTO tournament_bonus_grants (event_id, kind, subject_id, requested_bonus)
  VALUES (p_event_id, 'participant_credit', p_participant_id, COALESCE(p_bonus, 0))
  ON CONFLICT (event_id, kind, subject_id) DO NOTHING;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'already_granted', true);
  END IF;

  SELECT elo_change, elo_after INTO v_change, v_after
    FROM tournament_participants
   WHERE id = p_participant_id AND event_id = p_event_id
     FOR UPDATE;

  -- A participant id that does not belong to this event is a caller bug, and
  -- crediting it would move a number on an unrelated event.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No participant % in event %', p_participant_id, p_event_id;
  END IF;

  SELECT lo, hi INTO v_lo, v_hi FROM rating_bounds();

  -- elo_after MOVES WITH elo_change. NULL means this entry was never rated (no
  -- matches played) and adding a bonus to nothing would invent a rating, so it
  -- is left alone — the same rule the application applied.
  v_new_after := CASE
    WHEN v_after IS NULL THEN NULL
    ELSE LEAST(GREATEST(v_after + COALESCE(p_bonus, 0), v_lo), v_hi)
  END;

  UPDATE tournament_participants
     SET elo_change = COALESCE(v_change, 0) + COALESCE(p_bonus, 0),
         elo_after  = v_new_after
   WHERE id = p_participant_id;

  UPDATE tournament_bonus_grants
     SET applied_delta = COALESCE(p_bonus, 0)
   WHERE event_id = p_event_id AND kind = 'participant_credit' AND subject_id = p_participant_id;

  RETURN jsonb_build_object(
    'applied', true, 'already_granted', false,
    'elo_change', COALESCE(v_change, 0) + COALESCE(p_bonus, 0), 'elo_after', v_new_after
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.credit_participant_placement_bonus(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_participant_placement_bonus(uuid, uuid, integer) TO service_role;

-- ===========================================================================
-- F-002. A claim that actually excludes somebody.
-- ===========================================================================
--
-- 00178 introduced claim_dispute_for_resolution to stop a void or a casual
-- conversion running twice, and it moved the dispute to under_review to say so.
-- But it returned claimed = true whether or not the dispute was ALREADY
-- under_review, so two admins pressing Void and Convert to casual at the same
-- moment both received a claim and both went on to do their conflicting work.
-- A claim that never says no is a status update wearing a lock's clothes.
--
-- WHO holds it has to be recorded, because the retry case and the second
-- operator case look identical from inside the function otherwise. With
-- claimed_by, the same admin retrying after a lost response is let straight
-- through (that is the idempotence 00178 was built for) while a different admin
-- is turned away.
ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS claimed_by uuid REFERENCES public.players(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- Disputes already sitting in under_review when this migration runs were put
-- there by the old function, which recorded no holder. Leaving claimed_at NULL
-- makes them claimable by whoever asks next, which is the right answer: there
-- is no evidence anyone is still working on them, and refusing every one of
-- them forever would need a human to unwedge each by hand.

DROP FUNCTION IF EXISTS public.claim_dispute_for_resolution(uuid);

CREATE OR REPLACE FUNCTION public.claim_dispute_for_resolution(
  p_dispute_id uuid,
  p_actor_id   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_dispute disputes;
  -- How long a claim excludes other operators. Long enough that no realistic
  -- void or casual conversion is still in flight when it lapses, short enough
  -- that an admin whose session died does not wedge the dispute until someone
  -- notices. The work between the claim and the close is a handful of writes.
  v_claim_ttl CONSTANT interval := INTERVAL '15 minutes';
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'claim_dispute_for_resolution requires an actor';
  END IF;

  SELECT * INTO v_dispute FROM disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_dispute IS NULL THEN
    RAISE EXCEPTION 'Dispute not found';
  END IF;

  IF v_dispute.status = 'resolved' THEN
    RETURN jsonb_build_object(
      'claimed', false, 'already_resolved', true, 'held_by_other', false,
      'match_id', v_dispute.match_id
    );
  END IF;

  -- Somebody else is inside the window. This is the case the old function got
  -- wrong: it returned claimed = true here.
  IF v_dispute.claimed_by IS NOT NULL
     AND v_dispute.claimed_by <> p_actor_id
     AND v_dispute.claimed_at IS NOT NULL
     AND v_dispute.claimed_at > NOW() - v_claim_ttl THEN
    RETURN jsonb_build_object(
      'claimed', false, 'already_resolved', false, 'held_by_other', true,
      'match_id', v_dispute.match_id
    );
  END IF;

  -- under_review is the "someone is working on this" state that already exists
  -- in dispute_status; using it means the claim is visible on the console
  -- rather than being an invisible lock.
  UPDATE disputes
     SET status     = 'under_review',
         claimed_by = p_actor_id,
         claimed_at = NOW(),
         updated_at = NOW()
   WHERE id = p_dispute_id;

  RETURN jsonb_build_object(
    'claimed', true, 'already_resolved', false, 'held_by_other', false,
    'match_id', v_dispute.match_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_dispute_for_resolution(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_dispute_for_resolution(uuid, uuid) TO service_role;

-- ===========================================================================
-- F-025. A spent challenge stays spent.
-- ===========================================================================
--
-- 00181 made passkey challenges single-use by recording consumed_at, then
-- handed back the only key that undoes it: re-issuing the same hash and purpose
-- reset consumed_at to NULL. The reasoning was that a repeat hash can only mean
-- the caller re-issued, since two ceremonies cannot collide on a random
-- challenge — true, and still not a property to depend on, because the whole
-- value of the row is that it is the one authority on whether the ceremony was
-- already spent. A single-use token with a documented reset is not single-use.
--
-- Failing closed here costs nothing real: for the reset to matter at all,
-- something would have to re-issue a challenge whose hash equals one already
-- consumed, and a fresh random challenge never does.
CREATE OR REPLACE FUNCTION public.issue_passkey_challenge(
  p_challenge_hash text,
  p_purpose        text,
  p_user_id        uuid,
  p_ttl_seconds    integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Opportunistic sweep. The table is write-once per ceremony and read once,
  -- so it would otherwise grow for ever; doing it here keeps it to one
  -- statement on a path that is already writing, with no scheduled job to
  -- forget about. Only rows well past any possible use are removed.
  DELETE FROM passkey_challenges WHERE expires_at < NOW() - INTERVAL '1 day';

  INSERT INTO passkey_challenges (challenge_hash, purpose, user_id, expires_at)
  VALUES (p_challenge_hash, p_purpose, p_user_id, NOW() + make_interval(secs => p_ttl_seconds))
  -- A repeat of the same hash and purpose on an UNSPENT row means the caller
  -- re-issued: refresh it rather than failing the ceremony. The WHERE is what
  -- 00181 was missing — a consumed row is never revived.
  ON CONFLICT (challenge_hash, purpose) DO UPDATE
    SET user_id     = EXCLUDED.user_id,
        expires_at  = EXCLUDED.expires_at,
        created_at  = NOW()
    WHERE passkey_challenges.consumed_at IS NULL;

  -- Zero rows means the conflicting row was already consumed and the DO UPDATE
  -- was filtered out. Returning quietly would leave the caller running a
  -- ceremony whose challenge is not registered, which then fails at verify with
  -- no explanation; raise where the cause is still visible.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'passkey challenge already consumed — issue a fresh one';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.issue_passkey_challenge(text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_passkey_challenge(text, text, uuid, integer) TO service_role;

-- ===========================================================================
-- F-017. The preference allowlist moves to where the trust boundary is.
-- ===========================================================================
--
-- 00180 said, in as many words, "the caller keeps its whitelist. This function
-- decides nothing about WHICH keys may be written." That was written thinking
-- of the settings screen as the caller. But merge_my_notification_preferences
-- is granted to `authenticated` — any member's own JWT reaches it directly
-- through PostgREST, with no server action in between — so the caller is not
-- the settings screen, it is whoever holds the token. An allowlist enforced
-- only in the application is a comment.
--
-- What that buys an attacker is not dramatic, which is exactly why it is worth
-- closing cheaply: notification_preferences is a free-form jsonb column on
-- players, so arbitrary keys mean unbounded attacker-controlled storage on a
-- row the member owns, and any future reader of that blob inherits whatever was
-- put there.
--
-- The bound on session_reminder_lead_minutes is enforced here for the same
-- reason: the application clamps it, and the application is not the boundary.
-- An unclamped value schedules a reminder arbitrarily far out.
CREATE OR REPLACE FUNCTION public.assert_notification_patch(
  p_patch      jsonb,
  p_email_only boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Mirrors NOTIFICATION_CATEGORIES in packages/shared/src/utils/notifications.ts.
  -- A category added there must be added here or saving it starts failing —
  -- which is the intended direction: a new key is a deliberate act.
  v_categories TEXT[] := ARRAY['challenges', 'matches', 'sessions', 'tournaments', 'announcements'];
  v_key TEXT;
  v_val jsonb;
  v_minutes numeric;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'patch must be a json object';
  END IF;

  FOR v_key, v_val IN SELECT * FROM jsonb_each(p_patch)
  LOOP
    IF v_key = 'session_reminder_lead_minutes' THEN
      -- An email unsubscribe link may only ever change email keys; it must not
      -- be able to reach the reminder lead time or the push toggles.
      IF p_email_only THEN
        RAISE EXCEPTION 'key % is not settable from an email link', v_key;
      END IF;
      IF jsonb_typeof(v_val) <> 'number' THEN
        RAISE EXCEPTION 'session_reminder_lead_minutes must be a number';
      END IF;
      v_minutes := v_val::numeric;
      -- REMINDER_LEAD_MIN_MINUTES .. REMINDER_LEAD_MAX_MINUTES (one week).
      IF v_minutes < 5 OR v_minutes > 10080 OR v_minutes <> trunc(v_minutes) THEN
        RAISE EXCEPTION 'session_reminder_lead_minutes must be a whole number of minutes between 5 and 10080';
      END IF;

    ELSIF v_key LIKE 'email\_%' THEN
      IF substring(v_key FROM 7) <> ALL(v_categories) THEN
        RAISE EXCEPTION 'unknown notification preference key: %', v_key;
      END IF;
      IF jsonb_typeof(v_val) <> 'boolean' THEN
        RAISE EXCEPTION 'preference % must be a boolean', v_key;
      END IF;

    ELSE
      -- Bare keys are the push toggles; 00058's opt-in model reads them as
      -- exactly `true`, so anything non-boolean is meaningless stored data.
      IF p_email_only THEN
        RAISE EXCEPTION 'key % is not settable from an email link', v_key;
      END IF;
      IF v_key <> ALL(v_categories) THEN
        RAISE EXCEPTION 'unknown notification preference key: %', v_key;
      END IF;
      IF jsonb_typeof(v_val) <> 'boolean' THEN
        RAISE EXCEPTION 'preference % must be a boolean', v_key;
      END IF;
    END IF;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_notification_patch(jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_notification_patch(jsonb, boolean) TO service_role;

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

  -- The boundary, not the settings screen (F-017).
  PERFORM assert_notification_patch(p_patch, false);

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

REVOKE ALL ON FUNCTION public.merge_my_notification_preferences(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_my_notification_preferences(jsonb) TO authenticated, service_role;

-- The unsubscribe link's variant. It has no session at all — that is the whole
-- point of a one-click unsubscribe — so it keys by the address the signed token
-- carries and runs as the service role. p_email_only is true because an email
-- link may only ever change email keys: 00180's comment said so and only the
-- application enforced it.
CREATE OR REPLACE FUNCTION public.merge_notification_preferences_by_email(p_email text, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_merged jsonb;
BEGIN
  PERFORM assert_notification_patch(p_patch, true);

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

REVOKE ALL ON FUNCTION public.merge_notification_preferences_by_email(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_notification_preferences_by_email(text, jsonb) TO service_role;

-- ===========================================================================
-- End-state assertion. Same discipline as 00187: the migration proves what it
-- claims rather than asserting it in a comment.
-- ===========================================================================
DO $verify$
DECLARE
  v_bad TEXT[] := ARRAY[]::TEXT[];
  r RECORD;
  v_member_callable TEXT[] := ARRAY['merge_my_notification_preferences'];
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'apply_placement_bonus', 'credit_participant_placement_bonus',
         'claim_dispute_for_resolution', 'issue_passkey_challenge',
         'assert_notification_patch', 'merge_my_notification_preferences',
         'merge_notification_preferences_by_email')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      v_bad := v_bad || (r.proname || ': anon can execute');
    END IF;
    IF has_function_privilege('authenticated', r.oid, 'EXECUTE')
       AND r.proname <> ALL(v_member_callable) THEN
      v_bad := v_bad || (r.proname || ': authenticated can execute');
    END IF;
    IF NOT has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      v_bad := v_bad || (r.proname || ': service_role CANNOT execute');
    END IF;
  END LOOP;

  -- The old signatures must be gone, not merely superseded: a caller still on
  -- apply_placement_bonus(uuid, text, integer) would pay an unledgered bonus,
  -- and one on claim_dispute_for_resolution(uuid) would get a claim that
  -- excludes nobody.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'apply_placement_bonus'
                AND pg_get_function_identity_arguments(p.oid) = 'uuid, text, integer') THEN
    v_bad := v_bad || 'apply_placement_bonus(uuid,text,integer) still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'claim_dispute_for_resolution'
                AND pg_get_function_identity_arguments(p.oid) = 'uuid') THEN
    v_bad := v_bad || 'claim_dispute_for_resolution(uuid) still exists';
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION '00188 verification failed: %', array_to_string(v_bad, '; ');
  END IF;

  RAISE NOTICE '00188: grants, claims, challenges and the patch allowlist all verified.';
END
$verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;

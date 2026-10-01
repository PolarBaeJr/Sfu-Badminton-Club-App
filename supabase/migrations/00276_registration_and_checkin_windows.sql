-- ============================================================
-- 00276: REGISTRATION AND CHECK-IN WINDOWS
--
-- A tournament and each of its events can now say WHEN a member may enter and
-- when a member may check themselves in. Until now the only gate was the
-- event's status, which an exec moves by hand, so "registration closes Friday
-- at noon" was a promise somebody had to be awake to keep.
--
-- WHAT CHANGES.
--   * Four nullable timestamptz columns on BOTH tournaments and
--     tournament_events: registration_opens_at, registration_closes_at,
--     checkin_opens_at, checkin_closes_at. Each bound an event leaves blank
--     takes the tournament's, one bound at a time. NULL everywhere is today's
--     behaviour exactly. Per-row CHECKs refuse a window that closes at or
--     before it opens; the app also checks the EFFECTIVE pair, which no CHECK
--     can see.
--   * public.entry_window_state(opens, closes, now): 'not_open_yet', 'open' or
--     'closed'. One rule, written once, and proved below against the same table
--     the TypeScript twin (windowState in packages/shared) is tested on.
--   * enter_tournament_event refuses a member's own entry outside the
--     registration window (registration_not_open, registration_window_closed).
--   * set_field_entry_status refuses a member's OWN check-in (p_actor NULL with
--     'checked_in') outside the check-in window (checkin_not_open,
--     checkin_window_closed). An exec's check-in is never gated.
--
-- WHAT DOES NOT CHANGE. The windows are a gate, not a clock: nothing moves an
-- event's status when a window opens or closes, and there is no cron. An exec
-- still opens check-in and still adds entrants by hand at any time.
--
-- Both functions are copied from their latest definitions (00260 and 00271)
-- with only the window reads and refusals added; the lock lines the
-- entry-cap fence test and 00260's verify pin are byte-identical. Images
-- update before migrations run: the apps read the window columns in a
-- separate probe that degrades to "no window" while this file is pending.
-- ============================================================

BEGIN;

-- ---- the columns ----------------------------------------------------------

ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS registration_opens_at timestamptz;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS registration_closes_at timestamptz;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS checkin_opens_at timestamptz;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS checkin_closes_at timestamptz;

ALTER TABLE public.tournament_events ADD COLUMN IF NOT EXISTS registration_opens_at timestamptz;
ALTER TABLE public.tournament_events ADD COLUMN IF NOT EXISTS registration_closes_at timestamptz;
ALTER TABLE public.tournament_events ADD COLUMN IF NOT EXISTS checkin_opens_at timestamptz;
ALTER TABLE public.tournament_events ADD COLUMN IF NOT EXISTS checkin_closes_at timestamptz;

COMMENT ON COLUMN public.tournaments.registration_opens_at IS
  'When members may start entering this tournament''s events themselves (00276). NULL: no lower bound. An event''s own value wins.';
COMMENT ON COLUMN public.tournaments.registration_closes_at IS
  'When members stop being able to enter this tournament''s events themselves (00276). NULL: no upper bound. An event''s own value wins.';
COMMENT ON COLUMN public.tournaments.checkin_opens_at IS
  'When members may start checking themselves in (00276). An exec can check anybody in at any time. An event''s own value wins.';
COMMENT ON COLUMN public.tournaments.checkin_closes_at IS
  'When members stop being able to check themselves in (00276). An exec can check anybody in at any time. An event''s own value wins.';
COMMENT ON COLUMN public.tournament_events.registration_opens_at IS
  'This event''s own registration opening (00276). NULL takes the tournament''s.';
COMMENT ON COLUMN public.tournament_events.registration_closes_at IS
  'This event''s own registration close (00276). NULL takes the tournament''s.';
COMMENT ON COLUMN public.tournament_events.checkin_opens_at IS
  'This event''s own self check-in opening (00276). NULL takes the tournament''s.';
COMMENT ON COLUMN public.tournament_events.checkin_closes_at IS
  'This event''s own self check-in close (00276). NULL takes the tournament''s.';

ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_registration_window_order;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_registration_window_order
  CHECK (registration_opens_at IS NULL OR registration_closes_at IS NULL
         OR registration_closes_at > registration_opens_at);
ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_checkin_window_order;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_checkin_window_order
  CHECK (checkin_opens_at IS NULL OR checkin_closes_at IS NULL
         OR checkin_closes_at > checkin_opens_at);
ALTER TABLE public.tournament_events DROP CONSTRAINT IF EXISTS tournament_events_registration_window_order;
ALTER TABLE public.tournament_events ADD CONSTRAINT tournament_events_registration_window_order
  CHECK (registration_opens_at IS NULL OR registration_closes_at IS NULL
         OR registration_closes_at > registration_opens_at);
ALTER TABLE public.tournament_events DROP CONSTRAINT IF EXISTS tournament_events_checkin_window_order;
ALTER TABLE public.tournament_events ADD CONSTRAINT tournament_events_checkin_window_order
  CHECK (checkin_opens_at IS NULL OR checkin_closes_at IS NULL
         OR checkin_closes_at > checkin_opens_at);

-- ===========================================================================
-- entry_window_state: the one rule
-- ===========================================================================
--
-- Open from `opens` inclusive, closed from `closes` inclusive, and a NULL bound
-- never refuses. windowState in packages/shared/src/utils/tournament-windows.ts
-- is its twin.

CREATE OR REPLACE FUNCTION public.entry_window_state(p_opens timestamptz, p_closes timestamptz, p_now timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
  SELECT CASE
    WHEN p_opens IS NOT NULL AND p_now < p_opens THEN 'not_open_yet'
    WHEN p_closes IS NOT NULL AND p_now >= p_closes THEN 'closed'
    ELSE 'open'
  END;
$function$;

REVOKE ALL ON FUNCTION public.entry_window_state(timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.entry_window_state(timestamptz, timestamptz, timestamptz) TO service_role;

-- ===========================================================================
-- PROOF: the SQL rule gives every answer the TypeScript rule gives
-- ===========================================================================
--
-- One row per line, (opens, closes, now, expected). This list is read back by
-- tournament-windows-migration.test.ts and compared to WINDOW_STATE_CASES, so
-- editing one side alone fails the suite.

DO $proof$
DECLARE
  r     RECORD;
  v_got TEXT;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (NULL, NULL, '2026-10-01T12:00:00Z', 'open'),
      ('2026-10-01T12:00:00Z', NULL, '2026-10-01T11:59:59Z', 'not_open_yet'),
      ('2026-10-01T12:00:00Z', NULL, '2026-10-01T12:00:00Z', 'open'),
      (NULL, '2026-10-02T12:00:00Z', '2026-10-02T11:59:59Z', 'open'),
      (NULL, '2026-10-02T12:00:00Z', '2026-10-02T12:00:00Z', 'closed'),
      ('2026-10-01T12:00:00Z', '2026-10-02T12:00:00Z', '2026-09-30T00:00:00Z', 'not_open_yet'),
      ('2026-10-01T12:00:00Z', '2026-10-02T12:00:00Z', '2026-10-01T18:00:00Z', 'open'),
      ('2026-10-01T12:00:00Z', '2026-10-02T12:00:00Z', '2026-10-02T12:00:00Z', 'closed'),
      ('2026-10-01T12:00:00Z', '2026-10-02T12:00:00Z', '2026-10-05T00:00:00Z', 'closed'),
      ('2026-11-01T08:00:00Z', NULL, '2026-11-01T07:59:00Z', 'not_open_yet')
    ) AS t(opens, closes, at_now, expected)
  LOOP
    v_got := public.entry_window_state(r.opens::timestamptz, r.closes::timestamptz, r.at_now::timestamptz);
    IF v_got IS DISTINCT FROM r.expected THEN
      RAISE EXCEPTION '00276: entry_window_state(%, %, %) returned %, expected %',
        r.opens, r.closes, r.at_now, v_got, r.expected;
    END IF;
  END LOOP;
END;
$proof$;

-- ===========================================================================
-- enter_tournament_event: 00260's body, with the registration window
-- ===========================================================================
--
-- Copied from 00260 verbatim except: the window DECLAREs, the two window
-- columns joining the locked tournaments read and the locked event read, and
-- the window refusal right after registration_closed. The lock statements
-- themselves are unchanged.

CREATE OR REPLACE FUNCTION public.enter_tournament_event(
  p_event_id    UUID,
  p_player_id   UUID,
  p_elo_before  INTEGER,
  p_doubles     BOOLEAN,
  p_waiver_hash TEXT DEFAULT NULL,
  p_user_agent  TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status        TEXT;
  v_max           INTEGER;
  v_tournament    UUID;
  v_cap           INTEGER;
  v_waiver_text   TEXT;
  v_pairs         INTEGER;
  v_unpaired      INTEGER;
  v_before        INTEGER;
  v_after         INTEGER;
  v_singles       INTEGER;
  v_entries       INTEGER;
  v_t_status      TEXT;
  v_suspended     TIMESTAMPTZ;
  v_suspend_why   TEXT;
  v_allowed       membership_type[];
  v_banned        BOOLEAN;
  v_membership    membership_type;
  v_in_pair       BOOLEAN;
  v_event_type    TEXT;
  v_category      TEXT;
  v_required      TEXT;
  v_season        UUID;
  v_exempt        BOOLEAN;
  v_paid          BOOLEAN;
  v_effective     membership_type;
  v_t_reg_opens   TIMESTAMPTZ;
  v_t_reg_closes  TIMESTAMPTZ;
  v_e_reg_opens   TIMESTAMPTZ;
  v_e_reg_closes  TIMESTAMPTZ;
  v_reg_opens     TIMESTAMPTZ;
  v_reg_closes    TIMESTAMPTZ;
  v_win           TEXT;
BEGIN
  IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'Not permitted to act for another member' USING ERRCODE = '42501';
  END IF;

  IF p_elo_before IS NULL THEN
    RAISE EXCEPTION 'enter_tournament_event: p_elo_before may not be null';
  END IF;

  -- Which tournament, read WITHOUT a lock, purely to know which row to lock.
  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- THE FIELD LOCK, FIRST. Everything that changes who is in this event holds
  -- it: pairing, unpairing, swapping a partner, tearing a draw down. An entry
  -- changes who is in the event too, and until now it was the one operation
  -- that did so without asking. Taken before the row locks so the whole schema
  -- acquires these in one order; see the header for why that is the safe
  -- direction and not merely a convention.
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  -- PARENT FIRST. This is the lock the per-member cap needs, because the cap is
  -- a tournament property counted across events; a lock on one event row does
  -- not exclude an entry into a sibling event. Taking it before the event row
  -- also fixes the acquisition order for every caller, so two entries can queue
  -- but never deadlock.
  --
  -- The eligibility columns come off the SAME locked row (00196). They are not
  -- an extra cost and they are not advisory copies of what the caller read:
  -- they are the values as of a state no concurrent exec action can move.
  SELECT t.max_events_per_player,
         NULLIF(BTRIM(COALESCE(t.waiver_text, '')), ''),
         t.status::TEXT,
         t.suspended_at,
         NULLIF(BTRIM(COALESCE(t.suspension_reason, '')), ''),
         t.allowed_memberships,
         t.season_id,
         t.registration_opens_at,
         t.registration_closes_at
    INTO v_cap, v_waiver_text, v_t_status, v_suspended, v_suspend_why, v_allowed, v_season,
         v_t_reg_opens, v_t_reg_closes
    FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;

  -- Suspension before status, in that order, because it is the more specific
  -- and more actionable answer and it is what the player app says first.
  IF v_suspended IS NOT NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'tournament_suspended',
                              'suspension_reason', v_suspend_why);
  END IF;

  -- The same two statuses refuseClosedTournament refuses. 'draft' is
  -- deliberately NOT one of them: an unpublished tournament is not a closed
  -- one, and the app has always allowed it.
  IF v_t_status IN ('completed', 'archived') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'tournament_closed', 'status', v_t_status);
  END IF;

  -- THE MEMBER'S OWN FACTS, NOW UNDER A LOCK (00200). This read used to be
  -- unlocked and the header explained why that was tolerable: a ban or a
  -- membership change landing in the window is a change an exec makes and can
  -- see. That argument never covered competition_category, which is read below
  -- and decides whether this entry is legal at all, so the row is now held
  -- FOR SHARE until this transaction commits. An exec's updatePlayer queues
  -- behind the entry rather than racing it.
  --
  -- FOR SHARE, not FOR UPDATE: several members entering different events at
  -- once must not serialise on each other, and share locks do not conflict
  -- with each other. It is UPDATE that has to wait, and FOR SHARE is enough
  -- to make it.
  --
  -- Position matters: see the header. players is read after tournaments
  -- because merge_players takes them in that order, and reversing it here
  -- would close a cycle.
  --
  -- v_exempt (00260) is isFeeExempt: an exec or a fee-exempt member always
  -- enters as internal, off the same locked row.
  SELECT p.is_banned, p.membership_type, p.competition_category::TEXT,
         (COALESCE(p.is_exec, FALSE) OR COALESCE(p.fee_exempt, FALSE))
    INTO v_banned, v_membership, v_category, v_exempt
    FROM players p WHERE p.id = p_player_id FOR SHARE;

  IF v_banned IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'player_not_found');
  END IF;
  IF v_banned THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'player_suspended');
  END IF;

  -- screenMembershipEntry, in plpgsql (00260). A null or empty array is
  -- "open to everyone", which is the shape a tournament that never set the
  -- field has, and it skips the dues read entirely.
  --
  -- Otherwise the group this member ENTERS as is derived, not read: internal
  -- means this season's club fee is paid (or the member is exempt). The
  -- season is the tournament's own, else the active one; with neither there
  -- is nothing to have paid for and the stored group stands.
  IF v_allowed IS NOT NULL AND array_length(v_allowed, 1) > 0 THEN
    IF v_season IS NULL THEN
      SELECT s.id INTO v_season FROM seasons s WHERE s.active_flag = TRUE LIMIT 1;
    END IF;

    -- Unlocked on purpose; see the header for the residual race it leaves.
    -- A waived row counts, because paid_at is set on it.
    v_paid := v_season IS NOT NULL AND EXISTS (
      SELECT 1 FROM club_fees f
       WHERE f.fee_type = 'dues'
         AND f.player_id = p_player_id
         AND f.season_id = v_season
         AND f.paid_at IS NOT NULL
    );

    v_effective := entry_membership_rule(v_membership, v_exempt, v_paid, v_season IS NOT NULL);

    IF NOT (v_effective = ANY (v_allowed)) THEN
      -- The one refusal paying would fix, so the app can say so.
      IF 'internal' = ANY (v_allowed) AND v_season IS NOT NULL
         AND NOT v_paid AND NOT v_exempt THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'membership_unpaid',
                                  'allowed', to_jsonb(v_allowed));
      END IF;
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'membership_not_allowed',
                                'allowed', to_jsonb(v_allowed));
    END IF;
  END IF;

  -- The waiver gate, checked before anything is written. Presence only: see
  -- 00193's header for why the hash is not recomputed here.
  IF v_waiver_text IS NOT NULL AND NULLIF(BTRIM(COALESCE(p_waiver_hash, '')), '') IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'waiver_required');
  END IF;

  -- The event row is still locked, and still for the same reason: capacity and
  -- the duplicate check must see a state no other entry can move. event_type
  -- joins the read in 00200: the category gate below is about what THIS event
  -- requires, so it has to come off the locked row rather than from an argument
  -- the caller chose.
  SELECT e.status::TEXT, e.max_participants, e.event_type::TEXT, e.registration_opens_at, e.registration_closes_at
    INTO v_status, v_max, v_event_type, v_e_reg_opens, v_e_reg_closes
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_status <> 'registration' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'registration_closed', 'status', v_status);
  END IF;

  -- 00276: THE REGISTRATION WINDOW, a gate on top of the status above and
  -- never a replacement for it. Each bound is the event's own when set, else
  -- the tournament's, both read off the rows this function already holds.
  -- Only the member's own entry passes through here: an exec adding somebody
  -- goes through add_participants_under_field_lock, which has no window.
  v_reg_opens  := COALESCE(v_e_reg_opens, v_t_reg_opens);
  v_reg_closes := COALESCE(v_e_reg_closes, v_t_reg_closes);
  v_win := entry_window_state(v_reg_opens, v_reg_closes, now());
  IF v_win = 'not_open_yet' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'registration_not_open', 'opens_at', v_reg_opens);
  END IF;
  IF v_win = 'closed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'registration_window_closed', 'closes_at', v_reg_closes);
  END IF;

  -- ---- the competition category, re-asked under the lock (00200) -------
  --
  -- categoryRequiredBy, in plpgsql. The open events return NULL and reach
  -- none of this, which is the property that keeps an undeclared member
  -- playing the club's tournaments.
  v_required := CASE v_event_type
                  WHEN 'mens_singles'   THEN 'mens'
                  WHEN 'mens_doubles'   THEN 'mens'
                  WHEN 'womens_singles' THEN 'womens'
                  WHEN 'womens_doubles' THEN 'womens'
                  WHEN 'mixed_doubles'  THEN 'mixed'
                  ELSE NULL
                END;

  IF v_required IS NOT NULL THEN
    -- screenSelfEntry, in plpgsql, and stricter than the console on purpose:
    -- an undeclared member is refused as well as a mismatched one. Every
    -- member is undeclared the day 00111 applies, so a rule that admitted them
    -- would enforce nothing at all on the day it shipped.
    IF v_category IS NULL THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'category_undeclared',
                                'event_type', v_event_type);
    END IF;
    -- Mixed takes either declared category: the pair rule does the rest.
    IF v_required <> 'mixed' AND v_category <> v_required THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'category_mismatch',
                                'event_type', v_event_type);
    END IF;
  END IF;

  -- ALREADY HALF OF A PAIR. There is no unique constraint that catches this:
  -- the pair lives in a different table from the participant row, so the insert
  -- below succeeds and the member is in the event twice. This is the question
  -- the advisory lock above exists to make answerable: add_tournament_pair
  -- holds the same lock while it decides that neither player is spoken for, so
  -- the two orderings are the only two possible.
  --
  -- Withdrawn and disqualified pairs do not count, consistently with every
  -- other count in this function. The player app's own check is broader (it
  -- refuses on ANY pair row) and still fires first; that difference is its
  -- product decision to keep or change, not something this fence should
  -- silently adopt.
  SELECT EXISTS (
    SELECT 1 FROM tournament_pairs pr
     WHERE pr.event_id = p_event_id
       AND (pr.player1_id = p_player_id OR pr.player2_id = p_player_id)
       AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
  ) INTO v_in_pair;
  IF v_in_pair THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_in_pair');
  END IF;

  -- ---- capacity -------------------------------------------------------
  IF v_max IS NOT NULL AND v_max > 0 THEN
    IF p_doubles THEN
      SELECT COUNT(*) INTO v_pairs
        FROM tournament_pairs
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
      SELECT COUNT(*) INTO v_unpaired
        FROM tournament_participants
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');

      v_before := v_pairs + CEIL(v_unpaired / 2.0);
      v_after  := v_pairs + CEIL((v_unpaired + 1) / 2.0);

      IF v_after > v_max AND v_after > v_before THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_full');
      END IF;
    ELSE
      SELECT COUNT(*) INTO v_singles
        FROM tournament_participants
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
      IF v_singles >= v_max THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_full');
      END IF;
    END IF;
  END IF;

  -- ---- per-member entry cap (00098), now under the tournament lock -----
  IF v_cap IS NOT NULL AND v_cap > 0 THEN
    SELECT (
      (SELECT COUNT(*) FROM tournament_participants tp
         JOIN tournament_events te ON te.id = tp.event_id
        WHERE te.tournament_id = v_tournament AND tp.player_id = p_player_id
          AND COALESCE(tp.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
      +
      (SELECT COUNT(*) FROM tournament_pairs pr
         JOIN tournament_events te ON te.id = pr.event_id
        WHERE te.tournament_id = v_tournament
          AND (pr.player1_id = p_player_id OR pr.player2_id = p_player_id)
          AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
    ) INTO v_entries;

    IF v_entries >= v_cap THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_cap', 'cap', v_cap);
    END IF;
  END IF;

  -- ---- the write ------------------------------------------------------
  BEGIN
    INSERT INTO tournament_participants (event_id, player_id, elo_before, status)
    VALUES (p_event_id, p_player_id, p_elo_before, 'registered');
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_registered');
  END;

  -- ---- the evidence, in the same transaction --------------------------
  -- Idempotent on the natural key, so a retry of a partly-failed entry does not
  -- fail on the acceptance row. Nothing here is best-effort any more: if this
  -- raises, the participant row goes with it.
  IF v_waiver_text IS NOT NULL THEN
    INSERT INTO event_waiver_acceptances (player_id, tournament_id, waiver_hash, user_agent)
    VALUES (p_player_id, v_tournament, p_waiver_hash, p_user_agent)
    ON CONFLICT (player_id, tournament_id, waiver_hash) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ok', TRUE);
END;
$function$;

REVOKE ALL ON FUNCTION public.enter_tournament_event(uuid, uuid, integer, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enter_tournament_event(uuid, uuid, integer, boolean, text, text) TO service_role;

-- ===========================================================================
-- set_field_entry_status: 00271's body, with the self check-in window
-- ===========================================================================
--
-- Copied from 00271 verbatim except the window DECLAREs, the gate between
-- the undo guard and `v_already`, and one em dash in a comment recast.

CREATE OR REPLACE FUNCTION public.set_field_entry_status(p_entry_id uuid, p_is_pair boolean, p_new_status text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event      uuid;
  v_tournament uuid;
  v_status     text;
  v_locked     boolean;
  v_before     text;
  v_already    boolean;
  v_t_ci_opens  timestamptz;
  v_t_ci_closes timestamptz;
  v_e_ci_opens  timestamptz;
  v_e_ci_closes timestamptz;
  v_ci_opens    timestamptz;
  v_ci_closes   timestamptz;
  v_win         text;
BEGIN
  IF p_new_status NOT IN ('checked_in', 'no_show', 'withdrawn', 'disqualified', 'registered') THEN
    RAISE EXCEPTION 'set_field_entry_status: % is not a settable entry status', p_new_status;
  END IF;
  IF p_entry_id IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'set_field_entry_status: p_entry_id and p_is_pair may not be null';
  END IF;

  -- Unfenced, and only to learn which event to fence ON. Nothing is decided
  -- from this read; every value it produces is re-read below under the lock.
  IF p_is_pair THEN
    SELECT event_id INTO v_event FROM tournament_pairs WHERE id = p_entry_id;
  ELSE
    SELECT event_id INTO v_event FROM tournament_participants WHERE id = p_entry_id;
  END IF;
  IF v_event IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event::text));

  SELECT e.status::TEXT, e.tournament_id, e.draw_locked
    INTO v_status, v_tournament, v_locked
    FROM tournament_events e WHERE e.id = v_event FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- THE ENTRY, RE-READ UNDER THE LOCK. The row could have moved between the
  -- read above and this point; this is the value the write lands against.
  IF p_is_pair THEN
    SELECT status::TEXT INTO v_before FROM tournament_pairs
     WHERE id = p_entry_id AND event_id = v_event FOR UPDATE;
  ELSE
    SELECT status::TEXT INTO v_before FROM tournament_participants
     WHERE id = p_entry_id AND event_id = v_event FOR UPDATE;
  END IF;
  IF v_before IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;

  -- ---- the narrow status guards, per target status ----------------------
  IF p_new_status IN ('checked_in', 'no_show') THEN
    IF v_status = 'registration' THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                                'event_status', v_status);
    END IF;
  END IF;
  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_completed',
                              'event_status', v_status);
  END IF;

  -- Check-in is one of the two that moves a row FORWARD into play, so it cares
  -- what the row was: checking in somebody who has withdrawn would put them
  -- back in the field without anybody deciding to.
  IF p_new_status = 'checked_in' AND v_before NOT IN ('registered', 'checked_in') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_status',
                              'entry_status', v_before, 'event_status', v_status);
  END IF;

  -- AND SO IS no_show -- 00202. See the header above this function.
  IF p_new_status = 'no_show' AND v_before NOT IN ('registered', 'checked_in', 'no_show') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_status',
                              'entry_status', v_before, 'event_status', v_status);
  END IF;

  -- 00271: 'registered' IS THE UNDO, and only the undo. It takes a mistaken
  -- check-in or no-show back to waiting, and only while check-in is still
  -- open: once the draw is published the event has left 'checkin' and the
  -- field is what was drawn. It never revives a withdrawn or disqualified
  -- entry, and a no-show comes back as waiting, not as checked in, so the
  -- waiver check at the door still runs when they do turn up.
  IF p_new_status = 'registered' THEN
    IF v_status <> 'checkin' THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                                'event_status', v_status);
    END IF;
    IF v_before NOT IN ('checked_in', 'no_show', 'registered') THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_undoable',
                                'entry_status', v_before, 'event_status', v_status);
    END IF;
  END IF;

  -- 00276: THE MEMBER'S OWN CHECK-IN IS INSIDE THE CHECK-IN WINDOW.
  -- p_actor IS NULL is the discriminator, and it is a contract with the
  -- callers: the player app's self check-in and QR scan pass NULL with
  -- 'checked_in' (nobody at a desk checked them in), and every console
  -- 'checked_in' passes the exec's id. The console's no-show passes NULL too,
  -- but only with 'no_show', which never reaches here. An exec can therefore
  -- still check anybody in at any time. A repeat scan by somebody already
  -- checked in is not gated, so it still reports `already`.
  --
  -- The tournaments read takes NO lock. This function holds the event row,
  -- and the schema's order is tournaments before tournament_events; locking
  -- the parent now would invert it. A window edited in the gap is an exec's
  -- own change and is read on the next scan.
  IF p_new_status = 'checked_in' AND p_actor IS NULL AND v_before <> 'checked_in' THEN
    SELECT t.checkin_opens_at, t.checkin_closes_at
      INTO v_t_ci_opens, v_t_ci_closes
      FROM tournaments t WHERE t.id = v_tournament;
    -- The event row is already locked above.
    SELECT e.checkin_opens_at, e.checkin_closes_at
      INTO v_e_ci_opens, v_e_ci_closes
      FROM tournament_events e WHERE e.id = v_event;
    v_ci_opens  := COALESCE(v_e_ci_opens, v_t_ci_opens);
    v_ci_closes := COALESCE(v_e_ci_closes, v_t_ci_closes);
    v_win := entry_window_state(v_ci_opens, v_ci_closes, now());
    IF v_win = 'not_open_yet' THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'checkin_not_open',
                                'opens_at', v_ci_opens, 'event_status', v_status);
    END IF;
    IF v_win = 'closed' THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'checkin_window_closed',
                                'closes_at', v_ci_closes, 'event_status', v_status);
    END IF;
  END IF;

  v_already := (v_before = p_new_status);

  -- A REPEAT PRESS WRITES NOTHING BUT IS NOT AN ERROR HERE. exitDrawImpl needs
  -- to distinguish "already withdrawn, nothing to do" from "already withdrawn,
  -- but the forfeit cascade stopped partway and this retry is what finishes
  -- it". Only the caller knows which, because only it runs the cascade.
  IF NOT v_already THEN
    IF p_is_pair THEN
      UPDATE tournament_pairs
         SET status        = p_new_status,
             checked_in_at = CASE WHEN p_new_status = 'checked_in' THEN NOW()
                                  WHEN p_new_status = 'registered' THEN NULL ELSE checked_in_at END,
             checked_in_by = CASE WHEN p_new_status = 'checked_in' THEN p_actor
                                  WHEN p_new_status = 'registered' THEN NULL ELSE checked_in_by END
       WHERE id = p_entry_id;
    ELSE
      UPDATE tournament_participants
         SET status        = p_new_status,
             checked_in_at = CASE WHEN p_new_status = 'checked_in' THEN NOW()
                                  WHEN p_new_status = 'registered' THEN NULL ELSE checked_in_at END,
             checked_in_by = CASE WHEN p_new_status = 'checked_in' THEN p_actor
                                  WHEN p_new_status = 'registered' THEN NULL ELSE checked_in_by END
       WHERE id = p_entry_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'already', v_already,
    'entry_status_before', v_before,
    'event_status', v_status,
    'event_id', v_event,
    'tournament_id', v_tournament,
    'draw_locked', COALESCE(v_locked, FALSE)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.set_field_entry_status(uuid, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_field_entry_status(uuid, boolean, text, uuid) TO service_role;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================
--
-- The columns and their CHECKs, the three functions, everything 00260 asserted
-- about enter_tournament_event (re-asserted because this file replaces the
-- body those assertions read), the new window markers, the unlocked parent
-- read in set_field_entry_status, and the grants on all three.

DO $verify$
DECLARE
  v_bad  TEXT[] := ARRAY[]::TEXT[];
  v_oid  oid;
  v_src  TEXT;
  r      RECORD;
BEGIN
  -- ---- the eight columns ----------------------------------------------------
  FOR r IN
    SELECT tbl, col FROM (VALUES ('tournaments'), ('tournament_events')) AS a(tbl)
    CROSS JOIN (VALUES ('registration_opens_at'), ('registration_closes_at'),
                       ('checkin_opens_at'), ('checkin_closes_at')) AS b(col)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.col
         AND data_type = 'timestamp with time zone' AND is_nullable = 'YES'
    ) THEN
      v_bad := array_append(v_bad, format('%s.%s is missing or not nullable timestamptz', r.tbl, r.col));
    END IF;
  END LOOP;

  -- ---- the four CHECKs ------------------------------------------------------
  FOR r IN
    SELECT * FROM (VALUES
      ('public.tournaments', 'tournaments_registration_window_order'),
      ('public.tournaments', 'tournaments_checkin_window_order'),
      ('public.tournament_events', 'tournament_events_registration_window_order'),
      ('public.tournament_events', 'tournament_events_checkin_window_order')
    ) AS t(rel, con)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = r.con AND conrelid = r.rel::regclass AND contype = 'c'
    ) THEN
      v_bad := array_append(v_bad, format('%s is missing', r.con));
    END IF;
  END LOOP;

  -- ---- entry_window_state ---------------------------------------------------
  IF to_regprocedure('public.entry_window_state(timestamptz,timestamptz,timestamptz)') IS NULL THEN
    v_bad := array_append(v_bad, 'entry_window_state(timestamptz,timestamptz,timestamptz) missing');
  END IF;

  -- ---- enter_tournament_event -----------------------------------------------
  v_oid := to_regprocedure('public.enter_tournament_event(uuid,uuid,integer,boolean,text,text)');
  IF v_oid IS NULL THEN
    v_bad := array_append(v_bad, 'enter_tournament_event(uuid,uuid,integer,boolean,text,text) missing');
  ELSE
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;

    -- 00200: the players row is locked FOR SHARE.
    IF v_src !~ 'FROM players p WHERE p\.id = p_player_id FOR SHARE' THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: players row is not locked FOR SHARE');
    END IF;

    -- 00200: players is read AFTER the tournaments lock (merge_players order).
    IF position('FROM tournaments t WHERE t.id = v_tournament FOR UPDATE' in v_src) = 0
       OR position('FROM tournaments t WHERE t.id = v_tournament FOR UPDATE' in v_src)
          > position('FROM players p WHERE p.id = p_player_id FOR SHARE' in v_src) THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: players is locked before tournaments');
    END IF;

    -- 00196/00198: the advisory lock precedes both.
    IF position('pg_advisory_xact_lock' in v_src) = 0
       OR position('pg_advisory_xact_lock' in v_src)
          > position('FROM tournaments t WHERE t.id = v_tournament FOR UPDATE' in v_src) THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: advisory lock missing or not first');
    END IF;

    -- 00200: the category recheck, off the locked event row, after the lock.
    IF v_src NOT LIKE '%category_undeclared%' OR v_src NOT LIKE '%category_mismatch%' THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: competition category is not re-checked');
    END IF;
    IF v_src !~ 'e\.event_type::TEXT[^;]*FROM tournament_events e WHERE e\.id = p_event_id FOR UPDATE' THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: event_type does not come off the locked row');
    END IF;
    IF position('FROM players p WHERE p.id = p_player_id FOR SHARE' in v_src)
       > position('category_undeclared' in v_src) THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: category is checked before the row is locked');
    END IF;

    -- 00200: a refusal never carries the member's category back.
    IF v_src ~ 'v_category' AND v_src ~ 'jsonb_build_object[^;]*v_category' THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: refusal leaks the member category');
    END IF;

    -- 00260: the derived membership gate.
    IF position('entry_membership_rule(' in v_src) = 0 THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: does not apply entry_membership_rule');
    END IF;
    IF position('fee_type = ''dues''' in v_src) = 0 OR position('paid_at IS NOT NULL' in v_src) = 0 THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: does not read a paid dues row');
    END IF;
    IF position('t.season_id' in v_src) = 0 OR position('active_flag' in v_src) = 0 THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: season is not resolved from the tournament then the active season');
    END IF;
    IF position('membership_unpaid' in v_src) = 0 OR position('membership_not_allowed' in v_src) = 0 THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: lost one of the two membership refusals');
    END IF;
    -- The dues read comes after the member's row is locked, so it reads the
    -- exemption and the stored group off the same locked state.
    IF position('FROM club_fees' in v_src) = 0
       OR position('FROM club_fees' in v_src)
          < position('FROM players p WHERE p.id = p_player_id FOR SHARE' in v_src) THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: dues are read before the players row is locked');
    END IF;

    -- 00276: the registration window, off the locked rows.
    IF position('entry_window_state(' in v_src) = 0
       OR position('registration_not_open' in v_src) = 0
       OR position('registration_window_closed' in v_src) = 0 THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: lost the registration window refusals');
    END IF;
    IF v_src !~ 't\.registration_opens_at[^;]*FROM tournaments t WHERE t\.id = v_tournament FOR UPDATE' THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: tournament window does not come off the locked row');
    END IF;
    IF v_src !~ 'e\.registration_opens_at[^;]*FROM tournament_events e WHERE e\.id = p_event_id FOR UPDATE' THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: event window does not come off the locked row');
    END IF;
    IF position('registration_not_open' in v_src)
       < position('FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE' in v_src) THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: window is checked before the event row is locked');
    END IF;
  END IF;

  -- ---- set_field_entry_status -----------------------------------------------
  v_oid := to_regprocedure('public.set_field_entry_status(uuid,boolean,text,uuid)');
  IF v_oid IS NULL THEN
    v_bad := array_append(v_bad, 'set_field_entry_status(uuid,boolean,text,uuid) missing');
  ELSE
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
    IF position('entry_window_state(' in v_src) = 0
       OR position('checkin_not_open' in v_src) = 0
       OR position('checkin_window_closed' in v_src) = 0 THEN
      v_bad := array_append(v_bad, 'set_field_entry_status: lost the check-in window refusals');
    END IF;
    IF position('p_actor IS NULL' in v_src) = 0 THEN
      v_bad := array_append(v_bad, 'set_field_entry_status: the window no longer keys on a null actor');
    END IF;
    -- The parent is read WITHOUT a lock: the event row is already held, and
    -- locking tournaments after it would invert the schema's lock order.
    IF v_src ~ 'FROM tournaments\M.{0,200}FOR (UPDATE|SHARE)' THEN
      v_bad := array_append(v_bad, 'set_field_entry_status: locks the tournaments row after the event row');
    END IF;
    IF position('00271: ''registered'' IS THE UNDO' in v_src) = 0 THEN
      v_bad := array_append(v_bad, 'set_field_entry_status: lost the 00271 undo');
    END IF;
  END IF;

  -- ---- grants ---------------------------------------------------------------
  FOR r IN
    SELECT * FROM (VALUES
      ('public.entry_window_state(timestamptz,timestamptz,timestamptz)'),
      ('public.enter_tournament_event(uuid,uuid,integer,boolean,text,text)'),
      ('public.set_field_entry_status(uuid,boolean,text,uuid)')
    ) AS t(sig)
  LOOP
    v_oid := to_regprocedure(r.sig);
    CONTINUE WHEN v_oid IS NULL;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, format('%s is executable by anon or authenticated', r.sig));
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, format('%s is not executable by service_role', r.sig));
    END IF;
  END LOOP;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00276 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00276 verified: the window columns, entry_window_state, and both window gates are in place.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';

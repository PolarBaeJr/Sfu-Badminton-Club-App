-- ===========================================================================
-- 00260: INTERNAL MEANS THIS SEASON'S CLUB FEE IS PAID
-- ===========================================================================
--
-- THE DEFINITION, in the club owner's words:
--
--     "internal is when a person has paid for membership fees, externals is
--      anyone who is not paying our club fees, so without fees they would be
--      unable to join our internal tournaments"
--
-- THE RULE. At entry, the group a member enters as is derived from four facts:
-- the stored players.membership_type (null reads as 'internal'), whether they
-- are exempt (is_exec or fee_exempt), whether they have a paid dues row for the
-- entry's season, and whether there is such a season at all.
--
--     exempt                      internal
--     paid this season's dues     internal
--     no season                   the stored value, unchanged
--     otherwise                   alumni stays alumni; anyone else is external
--
-- "Paid" is a club_fees row with fee_type 'dues', this player and season, and
-- paid_at set. A waived row counts: the club chose to excuse the fee. A
-- name-keyed payment nobody has attached to the member yet does not, and nor
-- does a receipt still waiting for an exec to confirm it.
--
-- The refusal distinguishes the one case paying would fix. When the derived
-- group is not allowed, the event admits internal, there is a season and the
-- member is neither paid nor exempt, the reason is 'membership_unpaid' and the
-- app says where to pay. Every other refusal stays 'membership_not_allowed'.
-- A null or empty allow-list is still open to everyone.
--
-- THE SEASON is the tournament's own season_id, else the active season. The
-- fallback is only for the dues lookup; nothing here writes a season anywhere.
--
-- WHY IN SQL, and not only in the player app. The app screens first so it can
-- say something useful, but that screen runs hundreds of milliseconds before
-- the insert and under the service role. enter_tournament_event is the fence
-- every self-entry passes through (00196, 00200), so the rule is repeated here
-- where it cannot be skipped. entry_membership_rule holds the table once, and
-- the $proof$ block below runs it against every combination; the TypeScript
-- copy (ENTRY_MEMBERSHIP_CASES in packages/shared) is compared to that same
-- list by a test, so the two cannot drift.
--
-- WHAT THIS CLOSES. 00221 made @Internal, @Alumni and @External the member's
-- own pick in Discord, and the app follows the pick into membership_type. Its
-- header wrote down the cost: a member could assert the internal fee tier and
-- internal-only eligibility for themselves, correctable only by an exec
-- noticing the audit row. With this migration a self-asserted 'internal' buys
-- nothing at entry: only a paid club fee (or an exemption) does. The Discord
-- role itself is unchanged and out of scope here.
--
-- WHAT IS UNTOUCHED. No existing entry is re-checked and no existing fee row is
-- re-priced; the rule applies to entries made from now on. The console's own
-- entry paths (add_participants_under_field_lock, pairing) still skip the
-- membership gate, as they always have: an exec adding somebody by hand is an
-- explicit override by a named person.
--
-- THE RESIDUAL RACE, stated rather than papered over. The dues read is not
-- locked. An exec marking this member's club fee unpaid in the same instant as
-- the entry can lose to it, and the entry stands. Locking club_fees here would
-- add a table to the lock order every field writer agrees on (advisory,
-- tournaments, players, tournament_events) for a window of milliseconds on an
-- action an exec takes by hand and can see. The entry is visible on the
-- event's roster and can be withdrawn by an exec.
--
-- THE LOCK LINES ARE BYTE-IDENTICAL to 00200. Its verification, repeated
-- below, finds them by exact text, and so does
-- packages/shared/src/__tests__/tournament-entry-cap-fence.test.ts.

BEGIN;

-- ===========================================================================
-- entry_membership_rule: the table above, and nothing else
-- ===========================================================================
--
-- IMMUTABLE and pure: no reads, so the proof block can run it against every
-- combination without a single row in the database.

CREATE OR REPLACE FUNCTION public.entry_membership_rule(
  p_stored     membership_type,
  p_exempt     BOOLEAN,
  p_paid       BOOLEAN,
  p_has_season BOOLEAN
)
RETURNS membership_type
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
  SELECT CASE
           WHEN COALESCE(p_exempt, FALSE) OR COALESCE(p_paid, FALSE) THEN 'internal'::membership_type
           WHEN NOT COALESCE(p_has_season, FALSE) THEN COALESCE(p_stored, 'internal'::membership_type)
           WHEN p_stored = 'alumni' THEN 'alumni'::membership_type
           ELSE 'external'::membership_type
         END;
$function$;

-- PUBLIC is not enough: Supabase grants anon and authenticated EXECUTE by
-- default, and only naming them removes it (00126, 00187).
REVOKE ALL ON FUNCTION public.entry_membership_rule(membership_type, boolean, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.entry_membership_rule(membership_type, boolean, boolean, boolean) TO service_role;

-- ===========================================================================
-- enter_tournament_event: 00200's body, with the membership gate derived
-- ===========================================================================
--
-- Copied from 00200 verbatim except: the tournament's season_id joins the
-- locked tournaments read, v_exempt joins the locked players read, and the
-- allowed-groups check becomes the rule above. Em dashes in the copied comments
-- are recast; no statement text outside those three places changed.

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
         t.season_id
    INTO v_cap, v_waiver_text, v_t_status, v_suspended, v_suspend_why, v_allowed, v_season
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
  SELECT e.status::TEXT, e.max_participants, e.event_type::TEXT
    INTO v_status, v_max, v_event_type
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_status <> 'registration' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'registration_closed', 'status', v_status);
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
-- PROOF: the SQL rule gives every answer the TypeScript rule gives
-- ===========================================================================
--
-- One row per line, (stored, exempt, paid, has_season, expected). This list is
-- read back by entry-membership-migration.test.ts and compared to
-- ENTRY_MEMBERSHIP_CASES, so editing one side alone fails the suite.

DO $proof$
DECLARE
  r     RECORD;
  v_got membership_type;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('internal', false, false, false, 'internal'),
      ('internal', false, false, true, 'external'),
      ('internal', false, true, false, 'internal'),
      ('internal', false, true, true, 'internal'),
      ('internal', true, false, false, 'internal'),
      ('internal', true, false, true, 'internal'),
      ('internal', true, true, false, 'internal'),
      ('internal', true, true, true, 'internal'),
      ('alumni', false, false, false, 'alumni'),
      ('alumni', false, false, true, 'alumni'),
      ('alumni', false, true, false, 'internal'),
      ('alumni', false, true, true, 'internal'),
      ('alumni', true, false, false, 'internal'),
      ('alumni', true, false, true, 'internal'),
      ('alumni', true, true, false, 'internal'),
      ('alumni', true, true, true, 'internal'),
      ('external', false, false, false, 'external'),
      ('external', false, false, true, 'external'),
      ('external', false, true, false, 'internal'),
      ('external', false, true, true, 'internal'),
      ('external', true, false, false, 'internal'),
      ('external', true, false, true, 'internal'),
      ('external', true, true, false, 'internal'),
      ('external', true, true, true, 'internal')
    ) AS t(stored, exempt, paid, has_season, expected)
  LOOP
    v_got := public.entry_membership_rule(r.stored::membership_type, r.exempt, r.paid, r.has_season);
    IF v_got IS DISTINCT FROM r.expected::membership_type THEN
      RAISE EXCEPTION '00260: entry_membership_rule(%, %, %, %) returned %, expected %',
        r.stored, r.exempt, r.paid, r.has_season, v_got, r.expected;
    END IF;
  END LOOP;
END;
$proof$;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================
--
-- Everything 00200 asserted about enter_tournament_event, re-asserted because
-- this migration replaces the body those assertions read, plus the new gate.
-- The 00200 checks on publish_event_draw and promote_pool_qualifier are
-- repeated at their CURRENT signatures: 00202 re-signed publish_event_draw
-- (p_digests jsonb) and 00218 re-signed promote_pool_qualifier
-- (p_source_event_id), so 00200's literal signatures no longer exist.

DO $verify$
DECLARE
  v_bad  TEXT[] := ARRAY[]::TEXT[];
  v_oid  oid;
  v_src  TEXT;
  r      RECORD;
BEGIN
  -- ---- the replaced publish signatures must still be GONE -----------------
  IF to_regprocedure('public.publish_event_draw(uuid,text,boolean,integer,text,uuid)') IS NOT NULL THEN
    v_bad := array_append(v_bad, 'publish_event_draw(...,integer,text,uuid) exists again');
  END IF;
  IF to_regprocedure('public.publish_event_draw(uuid,text,boolean,integer)') IS NOT NULL THEN
    v_bad := array_append(v_bad, 'publish_event_draw(uuid,text,boolean,integer) exists again');
  END IF;

  -- ---- enter_tournament_event ------------------------------------------
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
  END IF;

  -- ---- entry_membership_rule ------------------------------------------
  IF to_regprocedure('public.entry_membership_rule(membership_type,boolean,boolean,boolean)') IS NULL THEN
    v_bad := array_append(v_bad, 'entry_membership_rule(membership_type,boolean,boolean,boolean) missing');
  END IF;

  -- ---- publish_event_draw (00200's properties, 00202's signature) ------
  v_oid := to_regprocedure('public.publish_event_draw(uuid,text,boolean,uuid[],boolean,text,uuid,jsonb)');
  IF v_oid IS NULL THEN
    v_bad := array_append(v_bad, 'publish_event_draw(uuid,text,boolean,uuid[],boolean,text,uuid,jsonb) missing');
  ELSE
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
    IF v_src NOT LIKE '%entrant_left%' THEN
      v_bad := array_append(v_bad, 'publish_event_draw: does not check for entrants who left');
    END IF;
    IF v_src NOT LIKE '%field_grew%' THEN
      v_bad := array_append(v_bad, 'publish_event_draw: does not check for entrants who arrived');
    END IF;
    IF v_src NOT LIKE '%p_entrants may not be null or empty%' THEN
      v_bad := array_append(v_bad, 'publish_event_draw: empty entrant list is not refused');
    END IF;
    IF v_src NOT LIKE '%superseded%' OR v_src NOT LIKE '%foreign_matches%' OR v_src NOT LIKE '%no_matches%' THEN
      v_bad := array_append(v_bad, 'publish_event_draw: lost a 00197 generation check');
    END IF;
  END IF;

  -- ---- 00198 and 00199 are still standing -------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
     WHERE tg.tgrelid = 'public.tournament_matches'::regclass
       AND tg.tgname = 'trg_tournament_match_generation'
       AND NOT tg.tgisinternal
  ) THEN
    v_bad := array_append(v_bad, '00197/00198 generation trigger is no longer attached');
  END IF;
  FOR r IN
    SELECT * FROM (VALUES
      ('public.add_participants_under_field_lock(uuid,uuid,jsonb)'),
      ('public.promote_pool_qualifier(uuid,uuid,boolean,uuid,uuid,text,integer,integer,uuid,timestamptz)')
    ) AS t(sig)
  LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      v_bad := array_append(v_bad, r.sig || ' missing');
    ELSE
      SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
      IF v_src NOT LIKE '%pg_advisory_xact_lock%' THEN
        v_bad := array_append(v_bad, r.sig || ': no longer takes the field lock');
      END IF;
    END IF;
  END LOOP;

  -- ---- grants ------------------------------------------------------------
  -- Only the two functions this migration grants. Asserting grants it does not
  -- set (00200 also checked publish_event_draw) would let unrelated drift on a
  -- host refuse this migration; the local copy already fails that check.
  FOR r IN
    SELECT * FROM (VALUES
      ('public.enter_tournament_event(uuid,uuid,integer,boolean,text,text)'),
      ('public.entry_membership_rule(membership_type,boolean,boolean,boolean)')
    ) AS t(sig)
  LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NOT NULL THEN
      IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
        v_bad := array_append(v_bad, r.sig || ': anon can execute');
      END IF;
      IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
        v_bad := array_append(v_bad, r.sig || ': authenticated can execute');
      END IF;
      IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
        v_bad := array_append(v_bad, r.sig || ': service_role CANNOT execute');
      END IF;
    END IF;
  END LOOP;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00260 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
END;
$verify$;

-- The function's response gained a reason code, and a new function exists.
NOTIFY pgrst, 'reload schema';

COMMIT;

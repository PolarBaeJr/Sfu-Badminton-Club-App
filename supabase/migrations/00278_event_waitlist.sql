-- ============================================================
-- 00278: AN OPTIONAL WAITLIST PER EVENT
--
-- A full event used to be the end of the conversation: "Event is full", and a
-- member who would have played if one place freed up had no way to say so.
-- The desk then found out who wanted in by asking around on the day.
--
-- WHAT CHANGES.
--   * Two columns on tournament_events: waitlist_enabled (off by default, so
--     every existing event behaves exactly as before) and
--     waitlist_auto_promote (on by default: a freed place goes to the member
--     at the head of the queue without anybody pressing a button).
--   * public.tournament_event_waitlist: one row per member per join. Only one
--     row per member per event can be 'waiting'; the others are history
--     ('promoted', 'left', 'removed', 'skipped'). Service role only, no RLS
--     policy, not in the realtime publication.
--   * fill_event_from_waitlist: the one promoter. It counts free places with
--     exactly the slot rule enter_tournament_event and
--     add_participants_under_field_lock use (pairs plus one slot per two
--     loose entrants for doubles, rows for singles, withdrawn and disqualified
--     not counted) and promotes in joined order, skipping a member who can no
--     longer be entered (suspended, inactive, already in the event, no rating
--     row, or at the tournament's entry cap) and telling them so. A named row
--     is the desk's manual promote.
--   * join_event_waitlist: the member's own join. It asks every question
--     enter_tournament_event asks, in the same order, before it asks the
--     waitlist's own.
--   * leave_event_waitlist, remove_from_event_waitlist: the member's own leave
--     and the desk's removal.
--   * set_event_waitlist: the switch. Refused outside registration and
--     check-in, on an external event, and when turning it off would strand
--     somebody already waiting.
--   * enter_tournament_event: refuses a member's own entry while anybody is
--     waiting (waitlist_queue), so nobody jumps the queue, and says in its
--     event_full answer whether the event has a waitlist.
--   * merge_players_disposable: the two waitlist columns join the twelve.
--
-- WHAT DOES NOT CHANGE. withdraw_from_tournament_event, remove_field_entry
-- and set_field_entry_status are untouched: the apps call
-- fill_event_from_waitlist after any of them frees a place, as a separate
-- step that can never make the original action fail. Waiting rows do not
-- count toward max_events_per_player; the promoter counts the cap again under
-- the tournaments row lock when it promotes.
--
-- LOCK ORDER, in every function here that locks: the event field advisory key,
-- then tournaments FOR UPDATE, then tournament_events FOR UPDATE, then the
-- players row FOR SHARE, the order 00196 fixed for the whole schema.
--
-- Notifications are in-app rows only (type 'general', metadata kind
-- 'waitlist_promoted' or 'waitlist_skipped'). Nothing is sent to Discord or by
-- email.
-- ============================================================

BEGIN;

-- ---- the columns ----------------------------------------------------------

ALTER TABLE public.tournament_events ADD COLUMN IF NOT EXISTS waitlist_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.tournament_events ADD COLUMN IF NOT EXISTS waitlist_auto_promote boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.tournament_events.waitlist_enabled IS
  'Whether members may join a waitlist for this event once it is full (00278). Off by default.';
COMMENT ON COLUMN public.tournament_events.waitlist_auto_promote IS
  'When a place frees up, enter the member at the head of the waitlist automatically (00278). Off means the desk promotes by hand.';

-- ---- the table ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tournament_event_waitlist (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                uuid NOT NULL REFERENCES public.tournament_events(id) ON DELETE CASCADE,
  player_id               uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  status                  text NOT NULL DEFAULT 'waiting'
                            CHECK (status IN ('waiting', 'promoted', 'left', 'removed', 'skipped')),
  joined_at               timestamptz NOT NULL DEFAULT now(),
  resolved_at             timestamptz,
  resolved_by             uuid REFERENCES public.players(id) ON DELETE SET NULL,
  reason                  text,
  -- No FK: the participant row can be removed by the desk later, and the
  -- history of having been promoted stays true either way.
  promoted_participant_id uuid
);

COMMENT ON TABLE public.tournament_event_waitlist IS
  'Members waiting for a place in a full event (00278). One waiting row per member per event; the rest is history.';

CREATE UNIQUE INDEX IF NOT EXISTS tournament_event_waitlist_one_waiting
  ON public.tournament_event_waitlist (event_id, player_id) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS tournament_event_waitlist_queue
  ON public.tournament_event_waitlist (event_id, joined_at, id) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS tournament_event_waitlist_player
  ON public.tournament_event_waitlist (player_id);

ALTER TABLE public.tournament_event_waitlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_event_waitlist FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.tournament_event_waitlist TO service_role;

-- ===========================================================================
-- fill_event_from_waitlist: the one promoter
-- ===========================================================================
--
-- p_waitlist_id NULL: fill every free place from the head of the queue, and
-- answer ok with nothing promoted when the event is not taking entries or has
-- no waitlist. That is the shape every caller that has just freed a place
-- wants: it must never turn their success into a failure.
--
-- p_waitlist_id set: the desk promoting one named member. Every reason that
-- member cannot go in comes back as a refusal and nothing is written, so the
-- desk decides what happens next.

CREATE OR REPLACE FUNCTION public.fill_event_from_waitlist(
  p_event_id    uuid,
  p_actor       uuid,
  p_waitlist_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament  uuid;
  v_t_name      text;
  v_cap         integer;
  v_t_status    text;
  v_suspended   timestamptz;
  v_status      text;
  v_locked      boolean;
  v_type        text;
  v_max         integer;
  v_enabled     boolean;
  v_external    boolean;
  v_doubles     boolean;
  v_closed      text;
  v_label       text;
  v_row         record;
  v_seen        boolean := false;
  v_pairs       integer;
  v_unpaired    integer;
  v_singles     integer;
  v_before      integer;
  v_after       integer;
  v_entries     integer;
  v_banned      boolean;
  v_active      boolean;
  v_elo         integer;
  v_reason      text;
  v_participant uuid;
  v_promoted    jsonb := '[]'::jsonb;
  v_skipped     jsonb := '[]'::jsonb;
BEGIN
  -- Which tournament, unlocked, purely to know which row to lock next.
  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  -- The cap is a tournament property counted across events, so it is read and
  -- counted under this row, as enter_tournament_event does.
  SELECT t.max_events_per_player, t.status::TEXT, t.suspended_at, t.name
    INTO v_cap, v_t_status, v_suspended, v_t_name
    FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;

  SELECT e.status::TEXT, e.draw_locked, e.event_type::TEXT, e.max_participants,
         e.waitlist_enabled, e.external_event
    INTO v_status, v_locked, v_type, v_max, v_enabled, v_external
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- The admin path's two statuses: a place freed during check-in still goes
  -- to the queue. Once the draw is made or locked, waiting rows stay waiting.
  v_closed := CASE
    WHEN v_suspended IS NOT NULL THEN 'tournament_suspended'
    WHEN v_t_status IN ('completed', 'archived') THEN 'tournament_closed'
    WHEN v_status NOT IN ('registration', 'checkin') THEN 'event_status'
    WHEN COALESCE(v_locked, FALSE) THEN 'draw_locked'
    WHEN COALESCE(v_external, FALSE) THEN 'external_event'
    ELSE NULL
  END;
  IF v_closed IS NOT NULL THEN
    RETURN jsonb_build_object('ok', p_waitlist_id IS NULL, 'reason', v_closed,
                              'event_status', v_status, 'promoted', '[]'::jsonb,
                              'skipped', '[]'::jsonb, 'tournament_id', v_tournament,
                              'event_id', p_event_id);
  END IF;

  IF p_waitlist_id IS NULL AND NOT COALESCE(v_enabled, FALSE) THEN
    RETURN jsonb_build_object('ok', TRUE, 'reason', 'waitlist_disabled', 'promoted', '[]'::jsonb,
                              'skipped', '[]'::jsonb, 'tournament_id', v_tournament,
                              'event_id', p_event_id);
  END IF;

  -- The same test add_participants_under_field_lock makes.
  v_doubles := v_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles');
  v_label := initcap(replace(v_type, '_', ' '));

  FOR v_row IN
    SELECT w.id, w.player_id
      FROM tournament_event_waitlist w
     WHERE w.event_id = p_event_id
       AND w.status = 'waiting'
       AND (p_waitlist_id IS NULL OR w.id = p_waitlist_id)
     ORDER BY w.joined_at, w.id
     FOR UPDATE
  LOOP
    v_seen := TRUE;

    -- ---- capacity, counted in DRAW SLOTS for doubles ----------------------
    -- enter_tournament_event's arithmetic for one more entrant, recounted for
    -- every promotion because the previous one moved it.
    IF v_max IS NOT NULL AND v_max > 0 THEN
      IF v_doubles THEN
        SELECT COUNT(*) INTO v_pairs FROM tournament_pairs
         WHERE event_id = p_event_id
           AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
        SELECT COUNT(*) INTO v_unpaired FROM tournament_participants
         WHERE event_id = p_event_id
           AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');

        v_before := v_pairs + CEIL(v_unpaired / 2.0);
        v_after  := v_pairs + CEIL((v_unpaired + 1) / 2.0);

        IF v_after > v_max AND v_after > v_before THEN
          IF p_waitlist_id IS NOT NULL THEN
            RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_full');
          END IF;
          EXIT;
        END IF;
      ELSE
        SELECT COUNT(*) INTO v_singles FROM tournament_participants
         WHERE event_id = p_event_id
           AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
        IF v_singles >= v_max THEN
          IF p_waitlist_id IS NOT NULL THEN
            RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_full');
          END IF;
          EXIT;
        END IF;
      END IF;
    END IF;

    -- ---- can this member still be entered? -------------------------------
    v_reason := NULL;

    -- After tournaments, as enter_tournament_event takes it.
    SELECT p.is_banned, p.active_flag INTO v_banned, v_active
      FROM players p WHERE p.id = v_row.player_id FOR SHARE;
    IF COALESCE(v_banned, FALSE) THEN
      v_reason := 'player_suspended';
    ELSIF NOT COALESCE(v_active, FALSE) THEN
      v_reason := 'inactive';
    END IF;

    -- Any row at all, withdrawn included: UNIQUE(event_id, player_id) would
    -- refuse the insert, and re-entering a withdrawn member is the desk's call.
    IF v_reason IS NULL AND EXISTS (
      SELECT 1 FROM tournament_participants tp0
       WHERE tp0.event_id = p_event_id AND tp0.player_id = v_row.player_id
    ) THEN
      v_reason := 'already_registered';
    END IF;

    IF v_reason IS NULL AND EXISTS (
      SELECT 1 FROM tournament_pairs pr
       WHERE pr.event_id = p_event_id
         AND (pr.player1_id = v_row.player_id OR pr.player2_id = v_row.player_id)
         AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
    ) THEN
      v_reason := 'already_in_pair';
    END IF;

    -- elo_before is the discipline's own rating, as the entry paths stamp it,
    -- and never a made-up 400.
    v_elo := NULL;
    IF v_reason IS NULL THEN
      SELECT CASE WHEN v_doubles THEN r.doubles_elo ELSE r.singles_elo END
        INTO v_elo FROM ratings r WHERE r.player_id = v_row.player_id;
      IF v_elo IS NULL THEN
        v_reason := 'no_rating';
      END IF;
    END IF;

    -- ---- per-member entry cap, under the tournament lock ------------------
    IF v_reason IS NULL AND v_cap IS NOT NULL AND v_cap > 0 THEN
      SELECT (
        (SELECT COUNT(*) FROM tournament_participants tp
           JOIN tournament_events te ON te.id = tp.event_id
          WHERE te.tournament_id = v_tournament AND tp.player_id = v_row.player_id
            AND COALESCE(tp.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
        +
        (SELECT COUNT(*) FROM tournament_pairs pr
           JOIN tournament_events te ON te.id = pr.event_id
          WHERE te.tournament_id = v_tournament
            AND (pr.player1_id = v_row.player_id OR pr.player2_id = v_row.player_id)
            AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
      ) INTO v_entries;
      IF v_entries >= v_cap THEN
        v_reason := 'entry_cap';
      END IF;
    END IF;

    IF v_reason IS NOT NULL THEN
      -- The desk asked for this member by name: say why, write nothing.
      IF p_waitlist_id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', v_reason, 'cap', v_cap);
      END IF;

      UPDATE tournament_event_waitlist
         SET status = 'skipped', reason = v_reason, resolved_at = now(), resolved_by = p_actor
       WHERE id = v_row.id;

      INSERT INTO notifications (player_id, type, title, body, metadata)
      VALUES (
        v_row.player_id, 'general', 'Waitlist update',
        CASE WHEN v_reason = 'entry_cap'
          THEN format('A place opened in %s at %s, but you are already entered in as many events as this tournament allows, so you have been taken off its waitlist.', v_label, v_t_name)
          ELSE format('A place opened in %s at %s, but you could not be entered, so you have been taken off its waitlist. Ask a tournament admin if you think this is a mistake.', v_label, v_t_name)
        END,
        jsonb_build_object('kind', 'waitlist_skipped', 'event_id', p_event_id,
                           'tournament_id', v_tournament, 'reason', v_reason)
      );

      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'player_id', v_row.player_id, 'waitlist_id', v_row.id, 'reason', v_reason));
      CONTINUE;
    END IF;

    -- ---- the promotion ----------------------------------------------------
    INSERT INTO tournament_participants (event_id, player_id, elo_before, status, added_by)
    VALUES (p_event_id, v_row.player_id, v_elo, 'registered', p_actor)
    RETURNING id INTO v_participant;

    UPDATE tournament_event_waitlist
       SET status = 'promoted', promoted_participant_id = v_participant,
           resolved_at = now(), resolved_by = p_actor
     WHERE id = v_row.id;

    INSERT INTO notifications (player_id, type, title, body, metadata)
    VALUES (
      v_row.player_id, 'general', 'You are in',
      format('A place opened in %s at %s and you have been entered from the waitlist.', v_label, v_t_name),
      jsonb_build_object('kind', 'waitlist_promoted', 'event_id', p_event_id,
                         'tournament_id', v_tournament)
    );

    v_promoted := v_promoted || jsonb_build_array(jsonb_build_object(
      'player_id', v_row.player_id, 'participant_id', v_participant, 'waitlist_id', v_row.id));
  END LOOP;

  IF p_waitlist_id IS NOT NULL AND NOT v_seen THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_waiting');
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'promoted', v_promoted, 'skipped', v_skipped,
                            'tournament_id', v_tournament, 'event_id', p_event_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.fill_event_from_waitlist(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fill_event_from_waitlist(uuid, uuid, uuid) TO service_role;

-- ===========================================================================
-- join_event_waitlist: the member's own join
-- ===========================================================================
--
-- The gate section is enter_tournament_event's, copied from 00276 in the same
-- order (without the p_elo_before check, which has no argument here), so a
-- member who could not enter the event cannot queue for it either. Then the
-- waitlist's own questions.

CREATE OR REPLACE FUNCTION public.join_event_waitlist(
  p_event_id    UUID,
  p_player_id   UUID,
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
  v_enabled       BOOLEAN;
  v_auto          BOOLEAN;
  v_external      BOOLEAN;
  v_entry_status  TEXT;
  v_room          BOOLEAN;
  v_id            UUID;
  v_joined        TIMESTAMPTZ;
  v_fill          JSONB;
  v_position      INTEGER;
  v_still         BOOLEAN;
BEGIN
  IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'Not permitted to act for another member' USING ERRCODE = '42501';
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
  SELECT e.status::TEXT, e.max_participants, e.event_type::TEXT, e.registration_opens_at, e.registration_closes_at,
         e.waitlist_enabled, e.waitlist_auto_promote, e.external_event
    INTO v_status, v_max, v_event_type, v_e_reg_opens, v_e_reg_closes, v_enabled, v_auto, v_external
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

  -- ---- the waitlist's own questions ------------------------------------
  IF NOT COALESCE(v_enabled, FALSE) OR COALESCE(v_external, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'waitlist_disabled');
  END IF;

  -- Any row, withdrawn included, as the promoter would refuse it.
  SELECT tp.status::TEXT INTO v_entry_status
    FROM tournament_participants tp
   WHERE tp.event_id = p_event_id AND tp.player_id = p_player_id;
  IF v_entry_status IS NOT NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_registered', 'entry_status', v_entry_status);
  END IF;

  IF EXISTS (
    SELECT 1 FROM tournament_event_waitlist w
     WHERE w.event_id = p_event_id AND w.player_id = p_player_id AND w.status = 'waiting'
  ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_waiting');
  END IF;

  -- In auto mode a waitlist with room and nobody in it is a queue for nothing:
  -- the member should simply enter. In manual mode the desk decides who goes
  -- in, so joining is allowed whenever the waitlist is on.
  IF COALESCE(v_auto, TRUE) AND NOT EXISTS (
    SELECT 1 FROM tournament_event_waitlist w
     WHERE w.event_id = p_event_id AND w.status = 'waiting'
  ) THEN
    v_room := TRUE;
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
          v_room := FALSE;
        END IF;
      ELSE
        SELECT COUNT(*) INTO v_singles
          FROM tournament_participants
         WHERE event_id = p_event_id
           AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
        IF v_singles >= v_max THEN
          v_room := FALSE;
        END IF;
      END IF;
    END IF;
    IF v_room THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_has_room');
    END IF;
  END IF;

  -- ---- per-member entry cap, under the tournament lock -----------------
  -- A member already at the cap could never be promoted, so they are told now
  -- rather than when a place frees up.
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
    INSERT INTO tournament_event_waitlist (event_id, player_id, status)
    VALUES (p_event_id, p_player_id, 'waiting')
    RETURNING id, joined_at INTO v_id, v_joined;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_waiting');
  END;

  -- The waiver evidence travels with the join, as it does with an entry, so a
  -- promotion later never lands a member who was not asked.
  IF v_waiver_text IS NOT NULL THEN
    INSERT INTO event_waiver_acceptances (player_id, tournament_id, waiver_hash, user_agent)
    VALUES (p_player_id, v_tournament, p_waiver_hash, p_user_agent)
    ON CONFLICT (player_id, tournament_id, waiver_hash) DO NOTHING;
  END IF;

  -- A self-heal in auto mode: if a place is free while others wait (a fill
  -- that was missed), this hands it out now, in queue order.
  IF COALESCE(v_auto, TRUE) THEN
    v_fill := fill_event_from_waitlist(p_event_id, NULL, NULL);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM tournament_event_waitlist w WHERE w.id = v_id AND w.status = 'waiting'
  ) INTO v_still;
  IF v_still THEN
    SELECT COUNT(*) INTO v_position
      FROM tournament_event_waitlist w
     WHERE w.event_id = p_event_id AND w.status = 'waiting'
       AND (w.joined_at, w.id) <= (v_joined, v_id);
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'waitlist_id', v_id,
    'position', v_position,
    'promoted', COALESCE(v_fill->'promoted', '[]'::jsonb),
    'tournament_id', v_tournament
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.join_event_waitlist(uuid, uuid, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_event_waitlist(uuid, uuid, boolean, text, text) TO service_role;

-- ===========================================================================
-- leave_event_waitlist: the member's own leave
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.leave_event_waitlist(p_event_id uuid, p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament uuid;
  v_id         uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'Not permitted to act for another member' USING ERRCODE = '42501';
  END IF;

  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT w.id INTO v_id
    FROM tournament_event_waitlist w
   WHERE w.event_id = p_event_id AND w.player_id = p_player_id AND w.status = 'waiting'
   FOR UPDATE;
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_waiting', 'tournament_id', v_tournament);
  END IF;

  UPDATE tournament_event_waitlist
     SET status = 'left', resolved_at = now(), resolved_by = p_player_id
   WHERE id = v_id;

  RETURN jsonb_build_object('ok', TRUE, 'tournament_id', v_tournament, 'event_id', p_event_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.leave_event_waitlist(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leave_event_waitlist(uuid, uuid) TO service_role;

-- ===========================================================================
-- remove_from_event_waitlist: the desk's removal
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.remove_from_event_waitlist(p_waitlist_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event      uuid;
  v_tournament uuid;
  v_player     uuid;
  v_status     text;
BEGIN
  -- Unlocked, only to learn which event to fence on.
  SELECT w.event_id INTO v_event FROM tournament_event_waitlist w WHERE w.id = p_waitlist_id;
  IF v_event IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_waiting');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event::text));

  SELECT w.status, w.player_id INTO v_status, v_player
    FROM tournament_event_waitlist w
   WHERE w.id = p_waitlist_id AND w.event_id = v_event
   FOR UPDATE;
  IF v_status IS DISTINCT FROM 'waiting' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_waiting', 'status', v_status);
  END IF;

  UPDATE tournament_event_waitlist
     SET status = 'removed', resolved_at = now(), resolved_by = p_actor
   WHERE id = p_waitlist_id;

  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = v_event;

  RETURN jsonb_build_object('ok', TRUE, 'event_id', v_event, 'tournament_id', v_tournament,
                            'player_id', v_player);
END;
$function$;

REVOKE ALL ON FUNCTION public.remove_from_event_waitlist(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_from_event_waitlist(uuid, uuid) TO service_role;

-- ===========================================================================
-- set_event_waitlist: the switch
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.set_event_waitlist(
  p_event_id uuid,
  p_enabled  boolean,
  p_auto     boolean,
  p_actor    uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament uuid;
  v_t_status   text;
  v_status     text;
  v_external   boolean;
  v_fill       jsonb;
BEGIN
  IF p_enabled IS NULL OR p_auto IS NULL THEN
    RAISE EXCEPTION 'set_event_waitlist: p_enabled and p_auto may not be null';
  END IF;

  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT t.status::TEXT INTO v_t_status
    FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;

  SELECT e.status::TEXT, e.external_event INTO v_status, v_external
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;

  IF v_status NOT IN ('registration', 'checkin') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status', 'event_status', v_status);
  END IF;
  IF COALESCE(v_external, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'external_event');
  END IF;

  IF NOT p_enabled AND EXISTS (
    SELECT 1 FROM tournament_event_waitlist w
     WHERE w.event_id = p_event_id AND w.status = 'waiting'
  ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'waitlist_not_empty');
  END IF;

  UPDATE tournament_events
     SET waitlist_enabled = p_enabled, waitlist_auto_promote = p_auto, updated_at = now()
   WHERE id = p_event_id;

  -- Switching to automatic with people already waiting hands out any free
  -- place now rather than at the next withdrawal.
  IF p_enabled AND p_auto THEN
    v_fill := fill_event_from_waitlist(p_event_id, p_actor, NULL);
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'tournament_id', v_tournament, 'event_id', p_event_id,
                            'promoted', COALESCE(v_fill->'promoted', '[]'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.set_event_waitlist(uuid, boolean, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_event_waitlist(uuid, boolean, boolean, uuid) TO service_role;

-- ===========================================================================
-- enter_tournament_event: 00276's body, with the queue
-- ===========================================================================
--
-- Copied from 00276 verbatim except: two DECLAREs, waitlist_enabled joining
-- the locked event read, the waitlist_queue refusal before capacity, and
-- 'waitlist' in both event_full answers. The lock statements are unchanged.

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
  v_waitlist      BOOLEAN;
  v_waiting       BOOLEAN;
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
  SELECT e.status::TEXT, e.max_participants, e.event_type::TEXT, e.registration_opens_at, e.registration_closes_at,
         e.waitlist_enabled
    INTO v_status, v_max, v_event_type, v_e_reg_opens, v_e_reg_closes, v_waitlist
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

  -- 00278: NOBODY JUMPS THE QUEUE. While anybody is waiting for this event,
  -- a free place is theirs, not the next member's to take by entering: the
  -- promoter hands it out in joined order. Waiting rows exist only while the
  -- waitlist is on, because it cannot be switched off with anybody in it.
  SELECT EXISTS (
    SELECT 1 FROM tournament_event_waitlist w
     WHERE w.event_id = p_event_id AND w.status = 'waiting'
  ) INTO v_waiting;
  IF v_waiting THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'waitlist_queue');
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
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_full', 'waitlist', COALESCE(v_waitlist, FALSE));
      END IF;
    ELSE
      SELECT COUNT(*) INTO v_singles
        FROM tournament_participants
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
      IF v_singles >= v_max THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_full', 'waitlist', COALESCE(v_waitlist, FALSE));
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
-- merge_players_disposable: the twelve from 00248, and the waitlist
-- ===========================================================================
--
-- A waiting row is a wish, not a record anybody else depends on: the loser's
-- rows go with the loser (player_id cascades), and resolved_by is attribution
-- that may go null.

CREATE OR REPLACE FUNCTION public.merge_players_disposable()
 RETURNS TABLE(tbl text, col text)
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT * FROM (VALUES
    ('notifications',             'player_id'),
    ('push_subscriptions',        'player_id'),
    ('calendar_feed_tokens',      'player_id'),
    ('ratings',                   'player_id'),
    ('reliability_metrics',       'player_id'),
    ('discord_outbox',            'requested_by'),
    ('data_api_consumers',        'created_by'),
    ('data_api_keys',             'minted_by'),
    ('data_api_keys',             'revoked_by'),
    ('club_event_signups',        'player_id'),
    ('club_events',               'created_by'),
    ('fee_submissions',           'reviewed_by'),
    ('tournament_event_waitlist', 'player_id'),
    ('tournament_event_waitlist', 'resolved_by')
  ) AS t(tbl, col);
$function$;

REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

DO $verify$
DECLARE
  v_bad  TEXT[] := ARRAY[]::TEXT[];
  v_oid  oid;
  v_src  TEXT;
  r      RECORD;
BEGIN
  -- ---- the columns ----------------------------------------------------------
  FOR r IN
    SELECT * FROM (VALUES ('waitlist_enabled', 'false'), ('waitlist_auto_promote', 'true')) AS t(col, def)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tournament_events' AND column_name = r.col
         AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = r.def
    ) THEN
      v_bad := array_append(v_bad, format('tournament_events.%s is missing, nullable, or not default %s', r.col, r.def));
    END IF;
  END LOOP;

  -- ---- the table, closed to anon and authenticated --------------------------
  IF to_regclass('public.tournament_event_waitlist') IS NULL THEN
    v_bad := array_append(v_bad, 'tournament_event_waitlist missing');
  ELSE
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tournament_event_waitlist'::regclass) THEN
      v_bad := array_append(v_bad, 'tournament_event_waitlist does not have RLS enabled');
    END IF;
    IF has_table_privilege('anon', 'public.tournament_event_waitlist', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', 'public.tournament_event_waitlist', 'SELECT,INSERT,UPDATE,DELETE') THEN
      v_bad := array_append(v_bad, 'tournament_event_waitlist is readable or writable by anon or authenticated');
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a
       WHERE c.oid = 'public.tournament_event_waitlist'::regclass
         AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))
    ) THEN
      v_bad := array_append(v_bad, 'tournament_event_waitlist relacl still names anon or authenticated');
    END IF;
    IF NOT has_table_privilege('service_role', 'public.tournament_event_waitlist', 'SELECT,INSERT,UPDATE,DELETE') THEN
      v_bad := array_append(v_bad, 'tournament_event_waitlist is not writable by service_role');
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE schemaname = 'public' AND tablename = 'tournament_event_waitlist'
    ) THEN
      v_bad := array_append(v_bad, 'tournament_event_waitlist is in a publication');
    END IF;
    IF to_regclass('public.tournament_event_waitlist_one_waiting') IS NULL THEN
      v_bad := array_append(v_bad, 'the one-waiting-row unique index is missing');
    END IF;
  END IF;

  -- ---- every function: one signature, service_role only --------------------
  FOR r IN
    SELECT * FROM (VALUES
      ('fill_event_from_waitlist', 'public.fill_event_from_waitlist(uuid,uuid,uuid)'),
      ('join_event_waitlist', 'public.join_event_waitlist(uuid,uuid,boolean,text,text)'),
      ('leave_event_waitlist', 'public.leave_event_waitlist(uuid,uuid)'),
      ('remove_from_event_waitlist', 'public.remove_from_event_waitlist(uuid,uuid)'),
      ('set_event_waitlist', 'public.set_event_waitlist(uuid,boolean,boolean,uuid)'),
      ('enter_tournament_event', 'public.enter_tournament_event(uuid,uuid,integer,boolean,text,text)'),
      ('merge_players_disposable', 'public.merge_players_disposable()')
    ) AS t(fn, sig)
  LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = r.fn) <> 1 THEN
      v_bad := array_append(v_bad, format('%s does not have exactly one signature', r.fn));
    END IF;
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      v_bad := array_append(v_bad, format('%s missing', r.sig));
      CONTINUE;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, format('%s is executable by anon or authenticated', r.sig));
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, format('%s is not executable by service_role', r.sig));
    END IF;
  END LOOP;

  -- ---- lock order: advisory, then tournaments, then the event ---------------
  FOR r IN
    SELECT * FROM (VALUES
      ('public.fill_event_from_waitlist(uuid,uuid,uuid)', 'FROM tournaments t WHERE t.id = v_tournament FOR UPDATE', 'FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE'),
      ('public.join_event_waitlist(uuid,uuid,boolean,text,text)', 'FROM tournaments t WHERE t.id = v_tournament FOR UPDATE', 'FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE'),
      ('public.set_event_waitlist(uuid,boolean,boolean,uuid)', 'FROM tournaments t WHERE t.id = v_tournament FOR UPDATE', 'FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE')
    ) AS t(sig, parent, child)
  LOOP
    v_oid := to_regprocedure(r.sig);
    CONTINUE WHEN v_oid IS NULL;
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
    IF position('pg_advisory_xact_lock(hashtext(''tournament_event_field'')' in v_src) = 0
       OR position(r.parent in v_src) = 0
       OR position(r.child in v_src) = 0
       OR position('pg_advisory_xact_lock' in v_src) > position(r.parent in v_src)
       OR position(r.parent in v_src) > position(r.child in v_src) THEN
      v_bad := array_append(v_bad, format('%s does not lock advisory, then tournaments, then the event', r.sig));
    END IF;
  END LOOP;
  FOR r IN
    SELECT * FROM (VALUES
      ('public.leave_event_waitlist(uuid,uuid)'),
      ('public.remove_from_event_waitlist(uuid,uuid)')
    ) AS t(sig)
  LOOP
    v_oid := to_regprocedure(r.sig);
    CONTINUE WHEN v_oid IS NULL;
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
    IF position('pg_advisory_xact_lock(hashtext(''tournament_event_field'')' in v_src) = 0
       OR position('pg_advisory_xact_lock' in v_src) > position('FOR UPDATE' in v_src) THEN
      v_bad := array_append(v_bad, format('%s does not take the field key before its row lock', r.sig));
    END IF;
  END LOOP;

  -- ---- the promoter's cap count is under the tournaments lock ---------------
  v_oid := to_regprocedure('public.fill_event_from_waitlist(uuid,uuid,uuid)');
  IF v_oid IS NOT NULL THEN
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
    IF position('JOIN tournament_events te' in v_src) = 0
       OR position('JOIN tournament_events te' in v_src)
          < position('FROM tournaments t WHERE t.id = v_tournament FOR UPDATE' in v_src) THEN
      v_bad := array_append(v_bad, 'fill_event_from_waitlist counts the entry cap before the tournaments lock');
    END IF;
    IF position('FROM players p WHERE p.id = v_row.player_id FOR SHARE' in v_src)
       < position('FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE' in v_src) THEN
      v_bad := array_append(v_bad, 'fill_event_from_waitlist locks a players row before the event row');
    END IF;
  END IF;

  -- ---- enter_tournament_event: everything 00276 asserted, and the queue -----
  v_oid := to_regprocedure('public.enter_tournament_event(uuid,uuid,integer,boolean,text,text)');
  IF v_oid IS NOT NULL THEN
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;

    IF v_src !~ 'FROM players p WHERE p\.id = p_player_id FOR SHARE' THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: players row is not locked FOR SHARE');
    END IF;
    IF position('FROM tournaments t WHERE t.id = v_tournament FOR UPDATE' in v_src) = 0
       OR position('FROM tournaments t WHERE t.id = v_tournament FOR UPDATE' in v_src)
          > position('FROM players p WHERE p.id = p_player_id FOR SHARE' in v_src) THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: players is locked before tournaments');
    END IF;
    IF position('pg_advisory_xact_lock' in v_src) = 0
       OR position('pg_advisory_xact_lock' in v_src)
          > position('FROM tournaments t WHERE t.id = v_tournament FOR UPDATE' in v_src) THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: advisory lock missing or not first');
    END IF;
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
    IF v_src ~ 'v_category' AND v_src ~ 'jsonb_build_object[^;]*v_category' THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: refusal leaks the member category');
    END IF;
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
    IF position('FROM club_fees' in v_src) = 0
       OR position('FROM club_fees' in v_src)
          < position('FROM players p WHERE p.id = p_player_id FOR SHARE' in v_src) THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: dues are read before the players row is locked');
    END IF;
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

    -- 00278: the queue, after the event row is locked and before capacity.
    IF position('waitlist_queue' in v_src) = 0 THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: does not refuse a queue jump');
    END IF;
    IF position('waitlist_queue' in v_src)
       < position('FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE' in v_src)
       OR position('waitlist_queue' in v_src) > position('---- capacity' in v_src) THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: the queue check is not between the event lock and capacity');
    END IF;
    IF v_src !~ 'e\.waitlist_enabled[^;]*FROM tournament_events e WHERE e\.id = p_event_id FOR UPDATE' THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: waitlist_enabled does not come off the locked row');
    END IF;
  END IF;

  -- ---- merge_players --------------------------------------------------------
  IF (SELECT count(*) FROM public.merge_players_disposable()) <> 14 THEN
    v_bad := array_append(v_bad, 'merge_players_disposable is not the fourteen rows');
  END IF;
  IF EXISTS (SELECT 1 FROM public.merge_players_unhandled()) THEN
    v_bad := array_append(v_bad, format('merge_players_unhandled is not empty: %s',
      (SELECT string_agg(tbl || '.' || col, ', ') FROM public.merge_players_unhandled())));
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00278 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00278 verified: the waitlist table, its five functions, the queue in enter_tournament_event and the merge rows are in place.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';

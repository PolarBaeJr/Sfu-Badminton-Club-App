-- ============================================================
-- 00110_session_instants.sql — resolve session wall-clock to instants
--
-- WHY
-- ---
-- `sessions` stores local wall clock (a DATE plus start_time/end_time),
-- not an instant. Exactly one live database function turned that into an
-- instant — session_checkin_open(), the RLS gate behind
-- session_attendance.attendance_insert — and it did so with
--
--     (date + start_time)::timestamp AT TIME ZONE 'America/Vancouver'
--
-- That single expression is the reason this database needs the IANA
-- timezone database to be correct, and it makes the answer depend on
-- which tzdata release the Postgres image happens to ship.
--
-- tzdata 2026b changed the Vancouver rule: British Columbia stops
-- observing the autumn fall-back, so from 2026-11-01 Vancouver is
-- permanently UTC-07:00. Measured on 2026-08-12:
--
--   prod supabase-db (PostgreSQL 17.6):
--     '2026-11-03 19:30' AT TIME ZONE 'America/Vancouver'
--       -> 2026-11-04 03:30:00+00       (pre-2026b rule, UTC-08:00)
--   node:24-alpine (tzdata 2026b), same wall clock:
--       -> 2026-11-04 02:30:00+00       (UTC-07:00)
--
-- Today the app and the database agree only because both carry the old
-- rule. Upgrading either one alone makes them disagree by an hour on
-- every session booked after 1 November — there are five on prod today
-- (2026-11-03, -11-10, -11-17, -11-24 and 2026-12-01, all 19:30-21:30).
--
-- WHAT THIS DOES
-- --------------
-- Adds the resolved instants to `sessions` as STORED GENERATED columns
-- and rewrites session_checkin_open() to compare NOW() against them, so
-- the gate itself never converts a wall clock and never names a
-- timezone. Postgres' tzdata can move underneath us and the check-in
-- window will not.
--
-- The wall clock stays the source of truth: `date`, `start_time` and
-- `end_time` are what an exec edits and what the UI shows. `starts_at`
-- and `ends_at` are derived from them, which is why they are GENERATED
-- rather than written by the application:
--
--   * There is no deploy-ordering hazard. A plain column written by the
--     app would break session creation in whichever direction it was
--     rolled out (NOT NULL violation if the migration lands first;
--     unknown column if the app does).
--   * "Edits must recompute" becomes structural. Postgres re-evaluates a
--     STORED generated column on every UPDATE of the row, so a stale
--     starts_at is not merely discouraged, it is unrepresentable — that
--     holds for a psql console edit and for a future code path nobody
--     has written yet, not just for the two call sites that exist today.
--   * Nothing computed by Node is ever stored. The "backfill ran on the
--     wrong tzdata and baked in the wrong answer" failure mode does not
--     exist here: the backfill is the ADD COLUMN itself, and for the
--     dates where tzdata releases disagree it uses a literal offset.
--
-- THE ONE DELIBERATE BEHAVIOUR CHANGE
-- -----------------------------------
-- For sessions dated on or after 2026-11-01 the check-in window moves
-- one hour earlier in absolute time, because that is where the window
-- actually is once BC stops changing its clocks. The old function
-- opened check-in an hour late and, more to the point, kept it open for
-- a full hour after the session had ended. Every other session in
-- existence resolves bit-identically to the old function.
--
-- Stated as an equivalence rather than as a diff: this function returns
-- exactly what the old function would return if Postgres were running
-- tzdata 2026b, for every input. Proof harness:
-- supabase/tests/00110_checkin_equivalence.sql.
-- ============================================================

-- ------------------------------------------------------------
-- club_local_instant(date, time) -> the UTC instant of a club-local
-- wall clock.
--
-- Two branches, and the split is the whole point:
--
--   date >= 2026-11-01  ->  a literal UTC-07:00. British Columbia does
--     not change its clocks again; verified under tzdata 2026b that
--     America/Vancouver is UTC-07:00 on 2026-11-01, 2027-01-15,
--     2027-06-15, 2028-01-15 and 2030-01-15 alike. This branch reads no
--     timezone data at all, so it cannot be wrong on an old image and
--     cannot change under a tzdata upgrade. 2026-11-01 is a safe
--     date-granularity boundary because 2026b places no transition on
--     that day — the whole day is UTC-07:00.
--
--   date < 2026-11-01   ->  AT TIME ZONE 'America/Vancouver'. Every
--     tzdata release, old and new, agrees about Vancouver before that
--     date: 2026b only removed *future* fall-backs. Using the real zone
--     here is not laziness, it is what keeps existing sessions
--     bit-identical to the function this migration replaces, including
--     Postgres' own tie-breaks on the ambiguous and non-existent local
--     hours of a DST changeover (see the note on ambiguity below).
--
-- Marked IMMUTABLE because a generated column requires it. For the
-- pinned branch that is literally true. For the historical branch it
-- inherits Postgres' own (long-standing, deliberate) claim that
-- timezone(text, timestamp) is immutable; the practical consequence is
-- that already-stored values are not rewritten when tzdata changes,
-- which is the behaviour we want.
--
-- If BC ever reverses its decision, this function is the one place to
-- change, and the fixture test in packages/shared will fail first.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION club_local_instant(p_date DATE, p_time TIME)
RETURNS TIMESTAMPTZ AS $$
  SELECT CASE
    WHEN p_date >= DATE '2026-11-01'
      THEN (p_date + p_time) AT TIME ZONE INTERVAL '-07:00'
    ELSE (p_date + p_time) AT TIME ZONE 'America/Vancouver'
  END;
$$ LANGUAGE sql IMMUTABLE STRICT;

COMMENT ON FUNCTION club_local_instant(DATE, TIME) IS
  'Club-local wall clock -> UTC instant. Pinned to UTC-07:00 from 2026-11-01 (BC permanent DST, tzdata 2026b) so no timezone data is consulted for future dates.';

-- ------------------------------------------------------------
-- The instants.
--
-- starts_at: always present. A session with no start_time starts at
--   local midnight, which is exactly the COALESCE the old function did.
--
-- ends_at: the resolved *wall-clock* close, and NULL precisely when the
--   session has a start_time but no end_time. That NULL is load-bearing,
--   not an omission. The old function had three closing branches:
--
--     end_time set              -> date + end_time            (stored)
--     start_time set, no end    -> start + default_duration    (NULL)
--     neither set               -> next day, local midnight    (stored)
--
--   The middle branch is the only one whose answer depends on
--   platform_settings.session_attendance -> default_duration_minutes,
--   which an admin can retune at runtime. Freezing it into a column
--   would silently take that lever away: an admin who changed the
--   default duration would find that existing sessions ignored it until
--   somebody touched the row. So the rule is: store the instant, keep
--   the offsets runtime. The same reasoning keeps
--   checkin_opens_minutes_before out of the data entirely — the opening
--   edge is starts_at minus a setting read on every call, so editing the
--   setting still moves it for every session immediately.
--
--   The three branches are mutually exclusive and exhaustive over the
--   four NULL combinations, and (end_time IS NULL AND start_time IS NOT
--   NULL) <-> (ends_at IS NULL) by construction, so no CHECK constraint
--   is needed to hold the invariant up.
--
-- Note the end_time < start_time case is preserved, not "fixed": a
-- session recorded as 21:00-19:00 closes before it opens, exactly as the
-- old function had it. Rolling such an end time to the next day would
-- widen the window, and widening this window is the one thing this
-- migration must not do.
-- ------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN starts_at TIMESTAMPTZ
    GENERATED ALWAYS AS (club_local_instant(date, COALESCE(start_time, '00:00'::time))) STORED,
  ADD COLUMN ends_at TIMESTAMPTZ
    GENERATED ALWAYS AS (
      CASE
        WHEN end_time IS NOT NULL THEN club_local_instant(date, end_time)
        WHEN start_time IS NOT NULL THEN NULL
        ELSE club_local_instant(date + 1, '00:00'::time)
      END
    ) STORED;

COMMENT ON COLUMN sessions.starts_at IS
  'Derived: the UTC instant of date + COALESCE(start_time, 00:00) in club time. Read-only; edit date/start_time instead.';
COMMENT ON COLUMN sessions.ends_at IS
  'Derived: the UTC instant the session closes by wall clock. NULL exactly when start_time is set and end_time is not — that case closes at starts_at + the runtime default_duration_minutes setting.';

-- ------------------------------------------------------------
-- The gate itself.
--
-- Same shape as 00008, same settings, same three closing branches, same
-- opening edge — with every AT TIME ZONE removed. It now reads instants
-- that were resolved at write time and does pure timestamptz arithmetic,
-- which is timezone-independent.
--
-- Fails closed at every seam: an unknown session, a session that is not
-- 'open', and (defensively — a generated column cannot produce it) a
-- NULL starts_at all return FALSE, and the final comparison is wrapped
-- in COALESCE so a NULL can never be mistaken for a pass. There is
-- deliberately no fallback to wall-clock conversion: falling back would
-- reintroduce exactly the dependency this migration exists to remove.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION session_checkin_open(p_session_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_session RECORD;
  v_settings JSONB;
  v_opens_minutes INTEGER;
  v_duration_minutes INTEGER;
  v_close_ts TIMESTAMPTZ;
BEGIN
  SELECT starts_at, ends_at, status INTO v_session
  FROM sessions WHERE id = p_session_id;

  IF NOT FOUND OR v_session.status <> 'open' OR v_session.starts_at IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT value INTO v_settings FROM platform_settings WHERE key = 'session_attendance';
  v_opens_minutes := (v_settings->>'checkin_opens_minutes_before')::int;
  v_duration_minutes := COALESCE((v_settings->>'default_duration_minutes')::int, 120);

  -- ends_at NULL == "start_time set, end_time not set": the duration branch.
  IF v_session.ends_at IS NOT NULL THEN
    v_close_ts := v_session.ends_at;
  ELSE
    v_close_ts := v_session.starts_at + make_interval(mins => v_duration_minutes);
  END IF;

  IF v_opens_minutes IS NOT NULL
     AND NOW() < v_session.starts_at - make_interval(mins => v_opens_minutes) THEN
    RETURN FALSE;
  END IF;

  RETURN COALESCE(NOW() < v_close_ts, FALSE);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- Unchanged from 00008; restated because CREATE OR REPLACE does not
-- touch privileges and this file should be readable on its own.
GRANT EXECUTE ON FUNCTION session_checkin_open(UUID) TO authenticated;

-- attendance_insert is NOT redefined. It calls session_checkin_open(session_id)
-- and that signature is unchanged, so the policy keeps working as written.

-- PostgREST caches the schema, and until it reloads it will reject
-- select=...,starts_at with a 400 rather than returning the column. Supabase's
-- DDL event trigger normally does this on its own; one explicit NOTIFY costs
-- nothing and closes the window.
NOTIFY pgrst, 'reload schema';

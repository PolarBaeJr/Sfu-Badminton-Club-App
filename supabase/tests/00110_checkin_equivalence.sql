-- ============================================================
-- 00110_checkin_equivalence.sql — proof that the rewritten
-- session_checkin_open() is no weaker than the one it replaces.
--
-- NOT a migration. This runs against a DISPOSABLE local Postgres and
-- touches nothing else. It must never be pointed at prod or staging.
--
--   docker run -d --name pgtest -e POSTGRES_PASSWORD=pw postgres:17
--   docker exec -i pgtest psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/00110_checkin_equivalence.sql
--
-- WHAT IT PROVES
-- --------------
-- The claim being defended is not "the new function behaves the same" —
-- it cannot, that is the point of the change. The claim is:
--
--   the new function returns exactly what the OLD function would have
--   returned had Postgres been running correct (tzdata 2026b) timezone
--   data, for every session shape and at every interesting instant.
--
-- So the same file is run twice, against two images with different
-- timezone data, and the two runs say different things:
--
--   postgres:17            (tzdata 2026b, verified below)
--       -> ZERO differences. new == old-under-correct-tzdata, always.
--          This is the security argument: the gate did not move except
--          where tzdata itself was wrong.
--
--   supabase/postgres:17.6.1.161  (the image prod runs, old tzdata)
--       -> differences ONLY on rows dated >= 2026-11-01, and only in
--          the interval where the two rules disagree. This bounds the
--          blast radius of the deploy to the five known future sessions.
--
-- Method: both functions are reparameterised to take `now` and the two
-- platform_settings tunables as arguments, because both call NOW() and
-- a boolean gate cannot be swept over its time axis otherwise. Nothing
-- else about either body is altered — compare old_open() below against
-- 00008_richer_attendance.sql line for line.
-- ============================================================

\set ON_ERROR_STOP on

-- ------------------------------------------------------------
-- 0. Report which timezone rule this image carries, so the output of a
--    run is self-describing rather than depending on the reader
--    remembering which container they started.
-- ------------------------------------------------------------
SELECT
  version() AS server,
  ('2026-11-03 19:30'::timestamp AT TIME ZONE 'America/Vancouver')::text AS vancouver_2026_11_03,
  CASE
    WHEN ('2026-11-03 19:30'::timestamp AT TIME ZONE 'America/Vancouver')
       = '2026-11-04 02:30:00+00'::timestamptz THEN 'tzdata 2026b or later (BC permanent DST)'
    ELSE 'tzdata older than 2026b (BC still falls back)'
  END AS tzdata_era;

-- ------------------------------------------------------------
-- 1. The subject under test, copied verbatim from 00110.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION club_local_instant(p_date DATE, p_time TIME)
RETURNS TIMESTAMPTZ AS $$
  SELECT CASE
    WHEN p_date >= DATE '2026-11-01'
      THEN (p_date + p_time) AT TIME ZONE INTERVAL '-07:00'
    ELSE (p_date + p_time) AT TIME ZONE 'America/Vancouver'
  END;
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE TABLE sessions (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  status TEXT NOT NULL DEFAULT 'open'
);

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

-- ------------------------------------------------------------
-- 2. OLD — 00008_richer_attendance.sql, unchanged apart from taking its
--    inputs as arguments instead of reading them from the row and from
--    platform_settings.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION old_open(
  p_date DATE, p_start TIME, p_end TIME, p_status TEXT,
  p_now TIMESTAMPTZ, p_opens INTEGER, p_duration INTEGER
) RETURNS BOOLEAN AS $$
DECLARE
  v_start_ts TIMESTAMPTZ;
  v_close_ts TIMESTAMPTZ;
BEGIN
  IF p_status <> 'open' THEN
    RETURN FALSE;
  END IF;

  v_start_ts := (p_date + COALESCE(p_start, '00:00'::time))::timestamp
    AT TIME ZONE 'America/Vancouver';

  IF p_end IS NOT NULL THEN
    v_close_ts := (p_date + p_end)::timestamp AT TIME ZONE 'America/Vancouver';
  ELSIF p_start IS NOT NULL THEN
    v_close_ts := v_start_ts + make_interval(mins => p_duration);
  ELSE
    v_close_ts := (p_date + 1)::timestamp AT TIME ZONE 'America/Vancouver';
  END IF;

  IF p_opens IS NOT NULL AND p_now < v_start_ts - make_interval(mins => p_opens) THEN
    RETURN FALSE;
  END IF;

  RETURN p_now < v_close_ts;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ------------------------------------------------------------
-- 3. NEW — 00110, likewise reparameterised. No timezone is named.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION new_open(
  p_starts_at TIMESTAMPTZ, p_ends_at TIMESTAMPTZ, p_status TEXT,
  p_now TIMESTAMPTZ, p_opens INTEGER, p_duration INTEGER
) RETURNS BOOLEAN AS $$
DECLARE
  v_close_ts TIMESTAMPTZ;
BEGIN
  IF p_status <> 'open' OR p_starts_at IS NULL THEN
    RETURN FALSE;
  END IF;

  IF p_ends_at IS NOT NULL THEN
    v_close_ts := p_ends_at;
  ELSE
    v_close_ts := p_starts_at + make_interval(mins => p_duration);
  END IF;

  IF p_opens IS NOT NULL AND p_now < p_starts_at - make_interval(mins => p_opens) THEN
    RETURN FALSE;
  END IF;

  RETURN COALESCE(p_now < v_close_ts, FALSE);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ------------------------------------------------------------
-- 4. The matrix.
--
-- Dates: both sides of the 2026-11-01 pin; both 2026 DST changeovers
-- (the spring-forward gap and the last-ever fall-back, which is the
-- ambiguous hour); a plain winter and a plain summer date; the five real
-- prod session dates; and a far-future date.
--
-- Times: all four NULL combinations, plus 01:30 (the hour that occurs
-- twice on a fall-back day and not at all on a spring-forward day),
-- 02:30 (inside the spring-forward gap), midnight, and an end_time
-- EARLIER than start_time.
--
-- Settings: the two seeded in 00008 (null / 120), the two live on prod
-- (30 / 60), and a zero opening edge.
-- ------------------------------------------------------------
CREATE TABLE dates_under_test (d DATE);
INSERT INTO dates_under_test VALUES
  ('2025-12-25'), ('2026-01-15'),
  ('2026-03-07'), ('2026-03-08'), ('2026-03-09'),   -- spring forward
  ('2026-06-21'), ('2026-09-15'),
  ('2026-10-30'), ('2026-10-31'),                   -- last day of the old rule
  ('2026-11-01'),                                   -- the pin, and the old fall-back day
  ('2026-11-02'), ('2026-11-03'), ('2026-11-10'),
  ('2026-11-17'), ('2026-11-24'), ('2026-12-01'),   -- the five real prod sessions
  ('2027-01-15'), ('2027-07-04'), ('2030-02-28');

CREATE TABLE times_under_test (start_time TIME, end_time TIME, label TEXT);
INSERT INTO times_under_test VALUES
  (NULL,    NULL,    'neither -> next-day midnight'),
  (NULL,    '21:30', 'end only'),
  ('19:30', NULL,    'start only -> runtime duration'),
  ('19:30', '21:30', 'both (the real prod shape)'),
  ('01:30', '03:30', 'ambiguous / non-existent local hour'),
  ('02:30', NULL,    'inside the spring-forward gap'),
  ('00:00', '23:59', 'full day'),
  ('21:00', '19:00', 'end before start -> already shut');

CREATE TABLE settings_under_test (opens INTEGER, duration INTEGER);
INSERT INTO settings_under_test VALUES
  (NULL, 120),   -- the 00008 seed
  (30,   60),    -- live on prod, measured 2026-08-12
  (0,    120);

INSERT INTO sessions (date, start_time, end_time, status)
SELECT d, t.start_time, t.end_time, s
FROM dates_under_test, times_under_test t, (VALUES ('open'), ('closed')) AS x(s);

-- Probe instants: every boundary either function can have, straddled by
-- one second either side, plus an hour either side (the size of the
-- disagreement), plus far outside on both ends.
CREATE VIEW probes AS
SELECT ses.*, cfg.opens, cfg.duration, p.now_ts
FROM sessions ses
CROSS JOIN settings_under_test cfg
CROSS JOIN LATERAL (
  SELECT edge + off AS now_ts
  FROM (
    SELECT unnest(ARRAY[
      -- old function's edges
      ((ses.date + COALESCE(ses.start_time,'00:00'::time))::timestamp AT TIME ZONE 'America/Vancouver')
        - make_interval(mins => COALESCE(cfg.opens, 0)),
      CASE
        WHEN ses.end_time IS NOT NULL
          THEN (ses.date + ses.end_time)::timestamp AT TIME ZONE 'America/Vancouver'
        WHEN ses.start_time IS NOT NULL
          THEN ((ses.date + ses.start_time)::timestamp AT TIME ZONE 'America/Vancouver')
               + make_interval(mins => cfg.duration)
        ELSE (ses.date + 1)::timestamp AT TIME ZONE 'America/Vancouver'
      END,
      -- new function's edges
      ses.starts_at - make_interval(mins => COALESCE(cfg.opens, 0)),
      COALESCE(ses.ends_at, ses.starts_at + make_interval(mins => cfg.duration))
    ]) AS edge
  ) e
  CROSS JOIN unnest(ARRAY[
    interval '-1 day', interval '-1 hour', interval '-1 second',
    interval '0', interval '1 second', interval '1 hour', interval '1 day'
  ]) AS off
) p;

-- ------------------------------------------------------------
-- 5. Result.
-- ------------------------------------------------------------
\echo ''
\echo '=== probe count ==='
SELECT count(*) AS probes_evaluated FROM probes;

\echo ''
\echo '=== differences, grouped (empty on tzdata 2026b) ==='
SELECT
  CASE WHEN date >= DATE '2026-11-01' THEN 'on/after 2026-11-01' ELSE 'before 2026-11-01' END AS era,
  count(*) AS differing_probes,
  count(*) FILTER (WHERE NOT o AND n) AS new_admits_old_refused,
  count(*) FILTER (WHERE o AND NOT n) AS new_refuses_old_admitted,
  min(date) AS first_date,
  max(date) AS last_date
FROM (
  SELECT date,
         old_open(date, start_time, end_time, status, now_ts, opens, duration) AS o,
         new_open(starts_at, ends_at, status, now_ts, opens, duration) AS n
  FROM probes
) r
WHERE o IS DISTINCT FROM n
GROUP BY 1
ORDER BY 1;

\echo ''
\echo '=== differences restricted to dates BEFORE the pin (must be zero) ==='
SELECT count(*) AS must_be_zero
FROM (
  SELECT old_open(date, start_time, end_time, status, now_ts, opens, duration) AS o,
         new_open(starts_at, ends_at, status, now_ts, opens, duration) AS n
  FROM probes WHERE date < DATE '2026-11-01'
) r
WHERE o IS DISTINCT FROM n;

\echo ''
\echo '=== a NULL starts_at can never open the gate ==='
SELECT new_open(NULL, NULL, 'open', now(), NULL, 120) AS null_starts_at_is_false,
       new_open(NULL, now() + interval '1 day', 'open', now(), NULL, 120) AS null_starts_with_end_is_false;

\echo ''
\echo '=== the five real prod sessions, both rules ==='
SELECT date, start_time, end_time,
       ((date + start_time)::timestamp AT TIME ZONE 'America/Vancouver')::text AS old_start_instant,
       starts_at::text AS new_start_instant,
       ends_at::text  AS new_end_instant
FROM sessions
WHERE date IN ('2026-11-03','2026-11-10','2026-11-17','2026-11-24','2026-12-01')
  AND start_time = '19:30' AND end_time = '21:30' AND status = 'open'
ORDER BY date;

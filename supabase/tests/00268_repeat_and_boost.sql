-- ============================================================
-- 00268_repeat_and_boost.sql: repeat challenges diminish, and the boost.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00268 applied:
--
--   ssh pi "docker exec -i supabase-staging-db psql -U postgres \
--     -d postgres -v ON_ERROR_STOP=1" < supabase/tests/00268_repeat_and_boost.sql
--
-- WHAT IT PROVES
-- --------------
-- The migration's verify block checks that the repeat block is present
-- and that the grants are right. It cannot check behaviour: which earlier
-- matches count, what factor they produce, and what a boost does to the
-- ratings and to a later void. This file walks real matches through
-- apply_match_result, boost_match_rating and void_club_match and asserts
-- the outcome.
--
-- THE BASELINE IS MEASURED, NOT RECOMPUTED. base_deltas() confirms the
-- same match with the rule switched off inside a subtransaction, reads the
-- deltas, and rolls the subtransaction back. So a case compares against
-- what 00230 would have written for that exact match, with no copy of the
-- K-factor or margin logic here to drift from the function.
--
-- Mutation-proven: deleting `v_event_mult := v_event_mult * v_repeat_factor`
-- from apply_match_result leaves every delta at its baseline, and case B
-- fails on it.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name) VALUES
 ('bbbbbbbb-0000-4000-8000-000000000001','repeat-harness-1@example.invalid','RepOne'),
 ('bbbbbbbb-0000-4000-8000-000000000002','repeat-harness-2@example.invalid','RepTwo'),
 ('bbbbbbbb-0000-4000-8000-000000000003','repeat-harness-3@example.invalid','RepThree'),
 ('bbbbbbbb-0000-4000-8000-000000000004','repeat-harness-4@example.invalid','RepFour'),
 ('bbbbbbbb-0000-4000-8000-000000000005','repeat-harness-5@example.invalid','RepFive'),
 ('bbbbbbbb-0000-4000-8000-000000000006','repeat-harness-6@example.invalid','RepSix'),
 ('bbbbbbbb-0000-4000-8000-000000000007','repeat-harness-7@example.invalid','RepSeven'),
 ('bbbbbbbb-0000-4000-8000-000000000008','repeat-harness-8@example.invalid','RepEight');
INSERT INTO ratings (player_id, singles_elo, doubles_elo)
SELECT id, 1000, 1000 FROM players WHERE id::text LIKE 'bbbbbbbb-0000-4000-8000-%';

-- Known values, whatever the database holds.
UPDATE platform_settings
   SET value = value || '{"repeat_decay_pct": 25, "repeat_window_days": 30, "repeat_min_factor": 0.10}'::jsonb
 WHERE key = 'rating_defaults';

-- The active season if there is one, otherwise a harness season made active.
CREATE TEMP TABLE ctx(season uuid, old_season uuid) ON COMMIT DROP;
INSERT INTO ctx(season) SELECT id FROM seasons WHERE active_flag LIMIT 1;
INSERT INTO ctx(season) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM ctx);
DO $$
DECLARE v uuid;
BEGIN
  IF (SELECT season FROM ctx) IS NULL THEN
    INSERT INTO seasons (name, start_date, active_flag, term, year)
    VALUES ('repeat harness', CURRENT_DATE - 60, TRUE, 'fall', 1998)
    RETURNING id INTO v;
    UPDATE ctx SET season = v;
  END IF;
  -- A year no real season uses, so the (term, year) key cannot collide.
  INSERT INTO seasons (name, start_date, end_date, active_flag, term, year)
  VALUES ('repeat harness past', CURRENT_DATE - 400, CURRENT_DATE - 300, FALSE, 'fall', 1999)
  RETURNING id INTO v;
  UPDATE ctx SET old_season = v;
END $$;

-- ------------------------------------------------------------
-- Helpers
-- ------------------------------------------------------------

-- A pending result, side a winning 21-15, ready for apply_match_result.
CREATE FUNCTION pg_temp.mk(
  p_type text, p_a uuid[], p_b uuid[], p_at timestamptz,
  p_ev event_type_enum DEFAULT 'rated_challenge',
  p_challenge boolean DEFAULT TRUE,
  p_walkover walkover_type DEFAULT NULL,
  p_season uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  v_m uuid := gen_random_uuid();
  v_c uuid;
  v_p uuid;
BEGIN
  IF p_challenge THEN
    v_c := gen_random_uuid();
    INSERT INTO challenges (id, type, rated_flag, event_type, created_by, status)
    VALUES (v_c, p_type::match_type_enum, p_ev <> 'casual', p_ev, p_a[1], 'accepted');
  END IF;
  INSERT INTO matches (id, match_type, event_type, rated_flag, format, result_status, submitted_by,
                       played_at, challenge_id, winner_side, walkover_type, season_id)
  VALUES (v_m, p_type::match_type_enum, p_ev, p_ev <> 'casual', 'single_21', 'pending_confirmation', p_a[1],
          p_at, v_c, 'a', p_walkover, COALESCE(p_season, (SELECT season FROM ctx)));
  IF p_walkover IS NULL THEN
    INSERT INTO match_games (match_id, game_number, side_a_score, side_b_score) VALUES (v_m, 1, 21, 15);
  END IF;
  FOREACH v_p IN ARRAY p_a LOOP
    INSERT INTO match_participants (match_id, player_id, team_side, pre_rating,
                                    points_scored, points_allowed, games_won, games_lost)
    SELECT v_m, v_p, 'a', CASE WHEN p_type = 'singles' THEN r.singles_elo ELSE r.doubles_elo END,
           21, 15, CASE WHEN p_walkover IS NULL THEN 1 ELSE 0 END, 0
      FROM ratings r WHERE r.player_id = v_p;
  END LOOP;
  FOREACH v_p IN ARRAY p_b LOOP
    INSERT INTO match_participants (match_id, player_id, team_side, pre_rating,
                                    points_scored, points_allowed, games_won, games_lost)
    SELECT v_m, v_p, 'b', CASE WHEN p_type = 'singles' THEN r.singles_elo ELSE r.doubles_elo END,
           15, 21, 0, CASE WHEN p_walkover IS NULL THEN 1 ELSE 0 END
      FROM ratings r WHERE r.player_id = v_p;
  END LOOP;
  RETURN v_m;
END $f$;

-- What 00230 would have written for this match: confirmed with the rule off,
-- read, then rolled back by the custom SQLSTATE.
CREATE FUNCTION pg_temp.base_deltas(p_m uuid, p_by uuid) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  BEGIN
    UPDATE platform_settings SET value = value || '{"repeat_decay_pct": 0}'::jsonb WHERE key = 'rating_defaults';
    PERFORM apply_match_result(p_m, p_by);
    SELECT jsonb_object_agg(player_id::text, rating_delta) INTO v FROM match_participants WHERE match_id = p_m;
    RAISE EXCEPTION USING ERRCODE = 'UU268';
  EXCEPTION WHEN SQLSTATE 'UU268' THEN NULL;
  END;
  RETURN v;
END $f$;

CREATE FUNCTION pg_temp.d(p_m uuid, p_p uuid) RETURNS integer LANGUAGE sql AS $f$
  SELECT rating_delta FROM match_participants WHERE match_id = p_m AND player_id = p_p
$f$;

CREATE FUNCTION pg_temp.elo(p_p uuid) RETURNS integer LANGUAGE sql AS $f$
  SELECT singles_elo FROM ratings WHERE player_id = p_p
$f$;

CREATE FUNCTION pg_temp.ok(p_cond boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF p_cond IS NOT TRUE THEN RAISE EXCEPTION '00268 harness FAILED: %', p_msg; END IF;
END $f$;

CREATE FUNCTION pg_temp.refused(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN SQLERRM;
END $f$;

-- ------------------------------------------------------------
-- The repeat factor
-- ------------------------------------------------------------
DO $$
DECLARE
  p1 uuid := 'bbbbbbbb-0000-4000-8000-000000000001';
  p2 uuid := 'bbbbbbbb-0000-4000-8000-000000000002';
  p3 uuid := 'bbbbbbbb-0000-4000-8000-000000000003';
  p4 uuid := 'bbbbbbbb-0000-4000-8000-000000000004';
  m uuid; m2 uuid; base jsonb; r RECORD; b1 int; b2 int;
BEGIN
  -- A. The first challenge between a pair is untouched.
  m := pg_temp.mk('singles', ARRAY[p1], ARRAY[p2], NOW() - interval '5 days');
  base := pg_temp.base_deltas(m, p2);
  PERFORM apply_match_result(m, p2);
  SELECT repeat_index, repeat_factor INTO r FROM matches WHERE id = m;
  PERFORM pg_temp.ok(r.repeat_index = 1 AND r.repeat_factor = 1.0000, 'A: first match '||r.repeat_index||'/'||r.repeat_factor);
  PERFORM pg_temp.ok(pg_temp.d(m, p1) = (base->>p1::text)::int AND pg_temp.d(m, p2) = (base->>p2::text)::int,
                     'A: first match deltas differ from the rule-off baseline');

  -- B. The same pair the other way round counts, and costs 25 percent.
  m := pg_temp.mk('singles', ARRAY[p2], ARRAY[p1], NOW() - interval '4 days');
  base := pg_temp.base_deltas(m, p1);
  PERFORM apply_match_result(m, p1);
  SELECT repeat_index, repeat_factor INTO r FROM matches WHERE id = m;
  PERFORM pg_temp.ok(r.repeat_index = 2 AND r.repeat_factor = 0.7500, 'B: reversed pair '||r.repeat_index||'/'||r.repeat_factor);
  b1 := (base->>p1::text)::int; b2 := (base->>p2::text)::int;
  PERFORM pg_temp.ok(abs(pg_temp.d(m, p2) - b2 * 0.75) <= 1 AND abs(pg_temp.d(m, p1) - b1 * 0.75) <= 1,
                     format('B: deltas %s/%s are not 0.75 of %s/%s', pg_temp.d(m, p2), pg_temp.d(m, p1), b2, b1));
  PERFORM pg_temp.ok(pg_temp.d(m, p2) > 0 AND pg_temp.d(m, p1) < 0, 'B: winner and loser moved the wrong way');
  PERFORM pg_temp.ok(pg_temp.d(m, p2) <> b2, 'B: delta equals the baseline, so the factor was not applied');

  -- C. A different pair starts again at 1.
  m := pg_temp.mk('singles', ARRAY[p1], ARRAY[p3], NOW() - interval '3 days');
  PERFORM apply_match_result(m, p3);
  PERFORM pg_temp.ok((SELECT repeat_index FROM matches WHERE id = m) = 1, 'C: a new pair was counted as a repeat');

  -- D. A match outside the window is not counted.
  m := pg_temp.mk('singles', ARRAY[p1], ARRAY[p4], NOW() - interval '40 days');
  PERFORM apply_match_result(m, p4);
  m := pg_temp.mk('singles', ARRAY[p1], ARRAY[p4], NOW() - interval '2 days');
  PERFORM apply_match_result(m, p4);
  PERFORM pg_temp.ok((SELECT repeat_index FROM matches WHERE id = m) = 1, 'D: a match 40 days back was counted');

  -- E. Casual, walkover and admin-entered matches get no factor and do not count.
  m := pg_temp.mk('singles', ARRAY[p1], ARRAY[p2], NOW() - interval '1 day', 'casual');
  PERFORM apply_match_result(m, p2);
  PERFORM pg_temp.ok((SELECT repeat_index FROM matches WHERE id = m) IS NULL, 'E: casual got a repeat index');
  m := pg_temp.mk('singles', ARRAY[p1], ARRAY[p2], NOW() - interval '1 day', 'rated_challenge', TRUE, 'no_show');
  PERFORM apply_match_result(m, p2);
  PERFORM pg_temp.ok((SELECT repeat_index FROM matches WHERE id = m) IS NULL, 'E: walkover got a repeat index');
  m := pg_temp.mk('singles', ARRAY[p1], ARRAY[p2], NOW() - interval '1 day', 'admin_entered', FALSE);
  PERFORM apply_match_result(m, p2);
  PERFORM pg_temp.ok((SELECT repeat_index FROM matches WHERE id = m) IS NULL, 'E: admin-entered got a repeat index');
  m := pg_temp.mk('singles', ARRAY[p1], ARRAY[p2], NOW());
  PERFORM apply_match_result(m, p2);
  SELECT repeat_index, repeat_factor INTO r FROM matches WHERE id = m;
  PERFORM pg_temp.ok(r.repeat_index = 3 AND r.repeat_factor = 0.5625,
                     'E: the third challenge read '||r.repeat_index||'/'||r.repeat_factor||', so a non-challenge counted');

  -- F. Doubles: the same four split differently are a new rivalry; the same
  -- two teams on swapped sides are not.
  m := pg_temp.mk('doubles', ARRAY[p1, p2], ARRAY[p3, p4], NOW() - interval '3 days');
  PERFORM apply_match_result(m, p3);
  PERFORM pg_temp.ok((SELECT repeat_index FROM matches WHERE id = m) = 1, 'F: first doubles');
  m := pg_temp.mk('doubles', ARRAY[p1, p3], ARRAY[p2, p4], NOW() - interval '2 days');
  PERFORM apply_match_result(m, p2);
  PERFORM pg_temp.ok((SELECT repeat_index FROM matches WHERE id = m) = 1, 'F: different teams counted as a repeat');
  m := pg_temp.mk('doubles', ARRAY[p3, p4], ARRAY[p1, p2], NOW() - interval '1 day');
  PERFORM apply_match_result(m, p1);
  PERFORM pg_temp.ok((SELECT repeat_index FROM matches WHERE id = m) = 2, 'F: the same teams swapped were not counted');

  -- G. pct 0 turns the rule off: the index still counts, the factor is 1.
  UPDATE platform_settings SET value = value || '{"repeat_decay_pct": 0}'::jsonb WHERE key = 'rating_defaults';
  m := pg_temp.mk('singles', ARRAY[p1], ARRAY[p3], NOW());
  PERFORM apply_match_result(m, p3);
  SELECT repeat_index, repeat_factor INTO r FROM matches WHERE id = m;
  PERFORM pg_temp.ok(r.repeat_index = 2 AND r.repeat_factor = 1.0000, 'G: pct 0 read '||r.repeat_index||'/'||r.repeat_factor);

  -- G2. A floor of 0 with a total decay confirms, and moves nothing.
  UPDATE platform_settings SET value = value || '{"repeat_decay_pct": 100, "repeat_min_factor": 0}'::jsonb
   WHERE key = 'rating_defaults';
  m := pg_temp.mk('singles', ARRAY[p1], ARRAY[p3], NOW());
  PERFORM apply_match_result(m, p3);
  SELECT repeat_index, repeat_factor, result_status INTO r FROM matches WHERE id = m;
  PERFORM pg_temp.ok(r.result_status = 'confirmed' AND r.repeat_factor = 0 AND r.repeat_index = 3,
                     'G2: floor 0 read '||r.repeat_index||'/'||r.repeat_factor||'/'||r.result_status);
  PERFORM pg_temp.ok(pg_temp.d(m, p1) = 0 AND pg_temp.d(m, p3) = 0, 'G2: a factor of 0 still moved a rating');

  UPDATE platform_settings
     SET value = value || '{"repeat_decay_pct": 25, "repeat_min_factor": 0.10}'::jsonb
   WHERE key = 'rating_defaults';

  -- M. Confirmation order cannot dodge the rule. Two pending results between
  -- a fresh pair, confirmed latest-played first: the second to confirm must
  -- still see the first, even though it was played earlier.
  m  := pg_temp.mk('singles', ARRAY[p2], ARRAY[p4], NOW() - interval '2 hours');
  m2 := pg_temp.mk('singles', ARRAY[p2], ARRAY[p4], NOW() - interval '1 hour');
  PERFORM apply_match_result(m2, p4);
  PERFORM apply_match_result(m, p4);
  PERFORM pg_temp.ok((SELECT repeat_index FROM matches WHERE id = m2) = 1
                     AND (SELECT repeat_index FROM matches WHERE id = m) = 2,
                     'M: confirming the later match first let the earlier one skip the decay');
  RAISE NOTICE '00268 repeat: A-G2 and M correct';
END $$;

-- ------------------------------------------------------------
-- The boost
-- ------------------------------------------------------------
DO $$
DECLARE
  p1 uuid := 'bbbbbbbb-0000-4000-8000-000000000001';
  p5 uuid := 'bbbbbbbb-0000-4000-8000-000000000005';
  p6 uuid := 'bbbbbbbb-0000-4000-8000-000000000006';
  p7 uuid := 'bbbbbbbb-0000-4000-8000-000000000007';
  p8 uuid := 'bbbbbbbb-0000-4000-8000-000000000008';
  m uuid; res jsonb; d5 int; d6 int; x5 int; x6 int; snap5 jsonb; snap6 jsonb;
  v_hi int; t uuid; err text;
BEGIN
  -- H. Boost 1.5 on a fresh pair.
  m := pg_temp.mk('singles', ARRAY[p5], ARRAY[p6], NOW() - interval '1 day');
  PERFORM apply_match_result(m, p6);
  d5 := pg_temp.d(m, p5); d6 := pg_temp.d(m, p6);
  x5 := ROUND(d5 * 0.5); x6 := ROUND(d6 * 0.5);
  SELECT to_jsonb(r) - 'singles_elo' - 'doubles_elo' - 'updated_at' INTO snap5 FROM ratings r WHERE player_id = p5;
  SELECT to_jsonb(r) - 'singles_elo' - 'doubles_elo' - 'updated_at' INTO snap6 FROM ratings r WHERE player_id = p6;

  res := boost_match_rating(m, p1, 1.5, 'a genuinely hard match');
  PERFORM pg_temp.ok((res->>'applied')::boolean, 'H: boost not applied');
  PERFORM pg_temp.ok(pg_temp.elo(p5) = 1000 + d5 + x5 AND pg_temp.elo(p6) = 1000 + d6 + x6,
                     format('H: elo %s/%s expected %s/%s', pg_temp.elo(p5), pg_temp.elo(p6), 1000 + d5 + x5, 1000 + d6 + x6));
  PERFORM pg_temp.ok(pg_temp.d(m, p5) = d5 + x5 AND pg_temp.d(m, p6) = d6 + x6, 'H: rating_delta does not carry the boost');
  PERFORM pg_temp.ok((SELECT bool_and(post_rating = pre_rating + rating_delta) FROM match_participants WHERE match_id = m),
                     'H: post_rating does not match pre_rating plus rating_delta');
  PERFORM pg_temp.ok((SELECT to_jsonb(r) - 'singles_elo' - 'doubles_elo' - 'updated_at' FROM ratings r WHERE player_id = p5) = snap5
                     AND (SELECT to_jsonb(r) - 'singles_elo' - 'doubles_elo' - 'updated_at' FROM ratings r WHERE player_id = p6) = snap6,
                     'H: a counter moved');
  PERFORM pg_temp.ok((SELECT elo_boost FROM matches WHERE id = m) = 1.50, 'H: elo_boost not recorded');
  PERFORM pg_temp.ok((SELECT count(*) FROM audit_logs WHERE target_id = m AND action_type = 'match_rating_boosted') = 1,
                     'H: expected one match_rating_boosted audit row');

  -- I. The same boost again is a no-op; a different one is refused.
  res := boost_match_rating(m, p1, 1.5, 'a genuinely hard match');
  PERFORM pg_temp.ok((res->>'already_boosted')::boolean AND pg_temp.elo(p5) = 1000 + d5 + x5, 'I: retry boosted twice');
  err := pg_temp.refused(format('SELECT boost_match_rating(%L, %L, 1.6, %L)', m, p1, 'a different boost'));
  PERFORM pg_temp.ok(err LIKE '%already boosted%', 'I: a second boost value was not refused: '||COALESCE(err, 'no error'));

  -- J. A void takes both players back to where they started.
  PERFORM void_club_match(m, p1, 'harness void after boost');
  PERFORM pg_temp.ok(pg_temp.elo(p5) = 1000 AND pg_temp.elo(p6) = 1000,
                     format('J: after void %s/%s expected 1000/1000', pg_temp.elo(p5), pg_temp.elo(p6)));

  -- K. Refusals.
  m := pg_temp.mk('singles', ARRAY[p7], ARRAY[p8], NOW(), p_season => (SELECT old_season FROM ctx));
  PERFORM apply_match_result(m, p8);
  err := pg_temp.refused(format('SELECT boost_match_rating(%L, %L, 1.5, %L)', m, p1, 'inactive season'));
  PERFORM pg_temp.ok(err LIKE '%active season%', 'K: inactive season: '||COALESCE(err, 'no error'));

  m := pg_temp.mk('singles', ARRAY[p7], ARRAY[p8], NOW());
  err := pg_temp.refused(format('SELECT boost_match_rating(%L, %L, 1.5, %L)', m, p1, 'still pending'));
  PERFORM pg_temp.ok(err LIKE '%confirmed%', 'K: pending: '||COALESCE(err, 'no error'));

  INSERT INTO tournaments (name, start_date) VALUES ('repeat harness', CURRENT_DATE) RETURNING id INTO t;
  PERFORM apply_match_result(m, p8);
  UPDATE matches SET tournament_id = t WHERE id = m;
  err := pg_temp.refused(format('SELECT boost_match_rating(%L, %L, 1.5, %L)', m, p1, 'tournament'));
  PERFORM pg_temp.ok(err LIKE '%tournament%', 'K: tournament: '||COALESCE(err, 'no error'));
  UPDATE matches SET tournament_id = NULL WHERE id = m;

  err := pg_temp.refused(format('SELECT boost_match_rating(%L, %L, 1, %L)', m, p1, 'not a boost'));
  PERFORM pg_temp.ok(err LIKE '%above 1%', 'K: boost 1 accepted');
  err := pg_temp.refused(format('SELECT boost_match_rating(%L, %L, 2.01, %L)', m, p1, 'too big'));
  PERFORM pg_temp.ok(err LIKE '%above 1%', 'K: boost 2.01 accepted');
  err := pg_temp.refused(format('SELECT boost_match_rating(%L, %L, 1.555, %L)', m, p1, 'three decimals'));
  PERFORM pg_temp.ok(err LIKE '%above 1%', 'K: boost 1.555 accepted');
  err := pg_temp.refused(format('SELECT boost_match_rating(%L, %L, 1.5, %L)', m, p1, 'hm'));
  PERFORM pg_temp.ok(err LIKE '%reason%', 'K: a short reason accepted');
  err := pg_temp.refused(format('SELECT boost_match_rating(%L, NULL, 1.5, %L)', m, 'no actor given'));
  PERFORM pg_temp.ok(err LIKE '%actor%', 'K: a NULL actor accepted');
  PERFORM pg_temp.ok((SELECT elo_boost FROM matches WHERE id = m) IS NULL, 'K: a refused boost left a mark');

  -- L. The clamp: what lands is recorded, not what was asked for.
  m := pg_temp.mk('singles', ARRAY[p5], ARRAY[p6], NOW() - interval '1 hour');
  PERFORM apply_match_result(m, p6);
  d5 := pg_temp.d(m, p5);
  PERFORM pg_temp.ok(d5 > 3, 'L: the winner needs a delta above 3 for the clamp to bite');
  SELECT rb.hi INTO STRICT v_hi FROM rating_bounds() rb;
  UPDATE ratings SET singles_elo = v_hi - 3 WHERE player_id = p5;
  PERFORM boost_match_rating(m, p1, 2.00, 'clamp at the ceiling');
  PERFORM pg_temp.ok(pg_temp.elo(p5) = v_hi AND pg_temp.d(m, p5) = d5 + 3,
                     format('L: elo %s delta %s expected %s and %s', pg_temp.elo(p5), pg_temp.d(m, p5), v_hi, d5 + 3));

  RAISE NOTICE '00268 boost: H-L correct';
END $$;

-- ------------------------------------------------------------
-- Members cannot reach the boost
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
DO $$
DECLARE state text;
BEGIN
  BEGIN PERFORM boost_match_rating(gen_random_uuid(), gen_random_uuid(), 1.5, 'member attempt');
  EXCEPTION WHEN others THEN state := SQLSTATE; END;
  IF state IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION '00268 harness FAILED: authenticated was not refused boost_match_rating at the grant (sqlstate %)',
      COALESCE(state, 'none');
  END IF;
  RAISE NOTICE '00268 authenticated: refused at the grant (42501)';
END $$;
RESET ROLE;

ROLLBACK;

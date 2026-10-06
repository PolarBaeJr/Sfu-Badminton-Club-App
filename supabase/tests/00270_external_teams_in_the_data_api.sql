-- ============================================================
-- 00270_external_teams_in_the_data_api.sql: the data API shows external
-- teams by an anonymous ref, and never by name.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00270 applied:
--
--   docker exec -i <db container> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/00270_external_teams_in_the_data_api.sql
--
-- WHAT IT PROVES
--   A  the event list marks the external event, and only it.
--   B  an external team is an entrant: no player_refs, external = true, a
--      64-hex external_ref that is stable, per-consumer, and never a
--      player_ref or a match_ref.
--   C  an external draw slot is served, not withheld: one element per side,
--      carrying the entrant's external_ref, with the winner and the games.
--   D  a disputed external slot is still withheld.
--   E  a member pair's draw elements keep their player_ref and say
--      external = false, and a hidden member still withholds the slot.
--   F  no name typed for an external team appears anywhere in the output.
--   G  the match gate still drops an external match from match history.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name) VALUES
 ('cccccccc-0270-4000-8000-000000000001','external-api-1@example.invalid','ApiOne'),
 ('cccccccc-0270-4000-8000-000000000002','external-api-2@example.invalid','ApiTwo'),
 ('cccccccc-0270-4000-8000-000000000003','external-api-3@example.invalid','ApiThree'),
 ('cccccccc-0270-4000-8000-000000000004','external-api-4@example.invalid','ApiFour');
UPDATE players SET status = 'recreational', hide_from_leaderboard = FALSE, deletion_requested_at = NULL
 WHERE id::text LIKE 'cccccccc-0270-4000-8000-%';
INSERT INTO ratings (player_id, singles_elo, doubles_elo)
SELECT id, 1000, 1000 FROM players WHERE id::text LIKE 'cccccccc-0270-4000-8000-%'
ON CONFLICT (player_id) DO NOTHING;

INSERT INTO data_api_consumers (id, name) VALUES
 ('cccccccc-0270-4000-8000-0000000000c1', '00270 harness one'),
 ('cccccccc-0270-4000-8000-0000000000c2', '00270 harness two');

INSERT INTO tournaments (id, name, start_date, status) VALUES
 ('cccccccc-0270-4000-8000-0000000000a1', 'external api harness', CURRENT_DATE, 'active');

-- X: the external event. N: a normal doubles event beside it.
INSERT INTO tournament_events
  (id, tournament_id, event_type, format, placement_bonus_enabled, group_count, external_event,
   games_per_match, points_per_game)
VALUES
  ('cccccccc-0270-4000-8000-0000000000e1', 'cccccccc-0270-4000-8000-0000000000a1',
   'mixed_doubles', 'round_robin', false, 1, true, 1, 15),
  ('cccccccc-0270-4000-8000-0000000000e2', 'cccccccc-0270-4000-8000-0000000000a1',
   'mixed_doubles', 'round_robin', false, 1, false, 1, 15);

CREATE TEMP TABLE ctx(x1 uuid, x2 uuid, xm1 uuid, xm2 uuid, n1 uuid, n2 uuid, nm uuid) ON COMMIT DROP;
INSERT INTO ctx VALUES (NULL, NULL, NULL, NULL, NULL, NULL, NULL);

DO $$
DECLARE
  v1 uuid;
  v2 uuid;
BEGIN
  v1 := add_external_tournament_pair('cccccccc-0270-4000-8000-0000000000e1', 'Quill Aspen', 'Rowan Egret', NULL);
  v2 := add_external_tournament_pair('cccccccc-0270-4000-8000-0000000000e1', 'Sorrel Crane', 'Tansy Plover', NULL, 'Harness Hawks');
  UPDATE ctx SET x1 = v1, x2 = v2;

  INSERT INTO tournament_pairs (event_id, player1_id, player2_id)
  VALUES ('cccccccc-0270-4000-8000-0000000000e2',
          'cccccccc-0270-4000-8000-000000000001', 'cccccccc-0270-4000-8000-000000000002')
  RETURNING id INTO v1;
  INSERT INTO tournament_pairs (event_id, player1_id, player2_id)
  VALUES ('cccccccc-0270-4000-8000-0000000000e2',
          'cccccccc-0270-4000-8000-000000000003', 'cccccccc-0270-4000-8000-000000000004')
  RETURNING id INTO v2;
  UPDATE ctx SET n1 = v1, n2 = v2;
END $$;

INSERT INTO tournament_matches (event_id, round_number, bracket_position, pair_a_id, pair_b_id, status, scores, winner_pair_id)
SELECT 'cccccccc-0270-4000-8000-0000000000e1', 1, 1, x1, x2, 'completed', '[{"a":15,"b":11}]'::jsonb, x1 FROM ctx;
INSERT INTO tournament_matches (event_id, round_number, bracket_position, pair_a_id, pair_b_id, status)
SELECT 'cccccccc-0270-4000-8000-0000000000e1', 1, 2, x2, x1, 'disputed' FROM ctx;
INSERT INTO tournament_matches (event_id, round_number, bracket_position, pair_a_id, pair_b_id, status)
SELECT 'cccccccc-0270-4000-8000-0000000000e2', 1, 1, n1, n2, 'ready' FROM ctx;
UPDATE ctx SET
  xm1 = (SELECT id FROM tournament_matches WHERE event_id = 'cccccccc-0270-4000-8000-0000000000e1' AND bracket_position = 1),
  xm2 = (SELECT id FROM tournament_matches WHERE event_id = 'cccccccc-0270-4000-8000-0000000000e1' AND bracket_position = 2),
  nm  = (SELECT id FROM tournament_matches WHERE event_id = 'cccccccc-0270-4000-8000-0000000000e2');

DO $$
DECLARE
  c1 constant uuid := 'cccccccc-0270-4000-8000-0000000000c1';
  c2 constant uuid := 'cccccccc-0270-4000-8000-0000000000c2';
  t  constant uuid := 'cccccccc-0270-4000-8000-0000000000a1';
  x  constant uuid := 'cccccccc-0270-4000-8000-0000000000e1';
  n  constant uuid := 'cccccccc-0270-4000-8000-0000000000e2';
  k record;
  r record;
  v_n int;
  v_ref1 text;
  v_ref2 text;
  v_text text;
  v_name text;
BEGIN
  SELECT * INTO k FROM ctx;

  -- A
  SELECT count(*) INTO v_n FROM data_api_tournament_events(c1, t) e
   WHERE (e.id = x AND e.external_event) OR (e.id = n AND NOT e.external_event);
  IF v_n <> 2 THEN RAISE EXCEPTION 'A: external_event not reported right (% of 2)', v_n; END IF;

  -- B
  SELECT count(*) INTO v_n FROM data_api_tournament_entrants(c1, t) e
   WHERE e.event_id = x AND e.external AND cardinality(e.player_refs) = 0
     AND e.external_ref ~ '^[0-9a-f]{64}$';
  IF v_n <> 2 THEN RAISE EXCEPTION 'B1: % of 2 external entrants served', v_n; END IF;
  SELECT count(*) INTO v_n FROM data_api_tournament_entrants(c1, t) e
   WHERE e.event_id = n AND NOT e.external AND e.external_ref IS NULL AND cardinality(e.player_refs) = 2;
  IF v_n <> 2 THEN RAISE EXCEPTION 'B2: % of 2 member pairs served as members', v_n; END IF;

  v_ref1 := data_api_external_ref(c1, k.x1);
  IF v_ref1 IS DISTINCT FROM data_api_external_ref(c1, k.x1) THEN RAISE EXCEPTION 'B3: ref not stable'; END IF;
  IF v_ref1 = data_api_external_ref(c2, k.x1) THEN RAISE EXCEPTION 'B4: two consumers share a ref'; END IF;
  IF v_ref1 = data_api_player_ref(c1, k.x1) OR v_ref1 = data_api_match_ref(c1, 'tournament', k.x1) THEN
    RAISE EXCEPTION 'B5: an external_ref equals a player_ref or match_ref of the same uuid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM data_api_tournament_entrants(c1, t) e WHERE e.external_ref = v_ref1) THEN
    RAISE EXCEPTION 'B6: the entrant does not carry data_api_external_ref of its pair';
  END IF;

  -- C
  SELECT * INTO r FROM data_api_tournament_draw(c1, x) d
   WHERE d.match_ref = data_api_match_ref(c1, 'tournament', k.xm1);
  IF r.withheld THEN RAISE EXCEPTION 'C1: a completed external slot was withheld'; END IF;
  IF jsonb_array_length(r.sides -> 'a') <> 1 OR jsonb_array_length(r.sides -> 'b') <> 1 THEN
    RAISE EXCEPTION 'C2: an external side is not one element: %', r.sides;
  END IF;
  v_ref2 := data_api_external_ref(c1, k.x2);
  IF r.sides -> 'a' -> 0 <> jsonb_build_object('player_ref', NULL, 'external', TRUE, 'external_ref', v_ref1)
     OR r.sides -> 'b' -> 0 <> jsonb_build_object('player_ref', NULL, 'external', TRUE, 'external_ref', v_ref2) THEN
    RAISE EXCEPTION 'C3: sides wrong: %', r.sides;
  END IF;
  IF r.winner_side IS DISTINCT FROM 'a' OR r.games <> '[{"game":1,"a":15,"b":11}]'::jsonb THEN
    RAISE EXCEPTION 'C4: winner or games wrong: % %', r.winner_side, r.games;
  END IF;

  -- D
  SELECT * INTO r FROM data_api_tournament_draw(c1, x) d
   WHERE d.match_ref = data_api_match_ref(c1, 'tournament', k.xm2);
  IF NOT r.withheld OR r.sides IS NOT NULL THEN RAISE EXCEPTION 'D: a disputed external slot was served'; END IF;

  -- E
  SELECT * INTO r FROM data_api_tournament_draw(c1, n) d
   WHERE d.match_ref = data_api_match_ref(c1, 'tournament', k.nm);
  IF r.withheld THEN RAISE EXCEPTION 'E1: a published member slot was withheld'; END IF;
  IF r.sides -> 'a' <> jsonb_build_array(
       jsonb_build_object('player_ref', data_api_player_ref(c1, 'cccccccc-0270-4000-8000-000000000001'),
                          'external', FALSE, 'external_ref', NULL),
       jsonb_build_object('player_ref', data_api_player_ref(c1, 'cccccccc-0270-4000-8000-000000000002'),
                          'external', FALSE, 'external_ref', NULL))
     AND r.sides -> 'a' <> jsonb_build_array(
       jsonb_build_object('player_ref', data_api_player_ref(c1, 'cccccccc-0270-4000-8000-000000000002'),
                          'external', FALSE, 'external_ref', NULL),
       jsonb_build_object('player_ref', data_api_player_ref(c1, 'cccccccc-0270-4000-8000-000000000001'),
                          'external', FALSE, 'external_ref', NULL)) THEN
    RAISE EXCEPTION 'E2: member side wrong: %', r.sides -> 'a';
  END IF;
  UPDATE players SET hide_from_leaderboard = TRUE WHERE id = 'cccccccc-0270-4000-8000-000000000003';
  SELECT * INTO r FROM data_api_tournament_draw(c1, n) d
   WHERE d.match_ref = data_api_match_ref(c1, 'tournament', k.nm);
  IF NOT r.withheld THEN RAISE EXCEPTION 'E3: a hidden member did not withhold the slot'; END IF;
  SELECT count(*) INTO v_n FROM data_api_tournament_entrants(c1, t) e WHERE e.event_id = n;
  IF v_n <> 1 THEN RAISE EXCEPTION 'E4: a pair with a hidden member was served (% rows)', v_n; END IF;
  UPDATE players SET hide_from_leaderboard = FALSE WHERE id = 'cccccccc-0270-4000-8000-000000000003';

  -- F
  SELECT concat_ws(' ',
    (SELECT jsonb_agg(to_jsonb(e)) FROM data_api_tournament_events(c1, t) e),
    (SELECT jsonb_agg(to_jsonb(e)) FROM data_api_tournament_entrants(c1, t) e),
    (SELECT jsonb_agg(to_jsonb(d)) FROM data_api_tournament_draw(c1, x) d))
    INTO v_text;
  FOREACH v_name IN ARRAY ARRAY['Quill', 'Aspen', 'Rowan', 'Egret', 'Sorrel', 'Crane', 'Tansy', 'Plover', 'Hawks'] LOOP
    IF position(lower(v_name) IN lower(v_text)) > 0 THEN
      RAISE EXCEPTION 'F: the output names %', v_name;
    END IF;
  END LOOP;

  -- G
  IF data_api_tournament_match_publishable(k.xm1) THEN
    RAISE EXCEPTION 'G: the match gate would serve an external match as history';
  END IF;

  RAISE NOTICE '00270 external teams in the data API: all cases passed';
END $$;

ROLLBACK;

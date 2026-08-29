-- ============================================================
-- 00203_conversion_arms.sql — the four conversion arms, the dispute
-- entry point, and its refusals.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- staging:
--
--   ssh pi "docker exec -i supabase-staging-db psql -U postgres \
--     -d postgres -v ON_ERROR_STOP=1" < supabase/tests/00203_conversion_arms.sql
--
-- WHAT IT PROVES, AND WHY IT IS NOT A UNIT TEST
-- ---------------------------------------------
-- 00203 moved Void and Convert-to-casual out of TypeScript and into one
-- SQL transaction each. The four-arm branch inside
-- convert_club_match_to_casual went with them, and it is the part a
-- rewrite silently collapses: the arms exist because production holds
-- rows in every one of those partial states, and no transaction can
-- retroactively repair them.
--
-- The migration's own verify block counts locks, note writes, audit rows
-- and callees. It deliberately does NOT assert the arms, because arm
-- SELECTION is behaviour and a structural count cannot tell a correct
-- arm from a transposed one. That is this file's job: it walks a real
-- match through each of the four states and asserts the outcome.
--
-- Two of the six cases are the ones a rewrite gets wrong:
--
--   A1a  a fully converted match must FALL THROUGH to the note and the
--        audit row, not return early — those are exactly what the failed
--        attempt never reached.
--   A4b  a match that was ALWAYS casual and is only now disputed has its
--        flags already written, so it looks finished. It is not: it still
--        needs confirming, and must reach the last arm.
--
-- Mutation-proven: making arm 1 test `settled` alone leaves A2 and A3
-- rated; making it test `flags_written` alone leaves A4b stuck at
-- 'disputed'. Both are caught below.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

CREATE TEMP TABLE cases(
  tag text, m uuid, ev event_type_enum, rated bool, st result_status,
  want_status result_status, want_reversed bool
) ON COMMIT DROP;

INSERT INTO cases VALUES
 ('A1a casual+unrated+confirmed', gen_random_uuid(), 'casual',         'f','confirmed','confirmed','f'),
 ('A1b casual+unrated+voided',    gen_random_uuid(), 'casual',         'f','voided',   'voided',   'f'),
 ('A2  rated+voided',             gen_random_uuid(), 'rated_challenge','t','voided',   'voided',   'f'),
 ('A3  rated+confirmed',          gen_random_uuid(), 'rated_challenge','t','confirmed','voided',   't'),
 ('A4a rated+disputed',           gen_random_uuid(), 'rated_challenge','t','disputed', 'confirmed','f'),
 ('A4b casual+unrated+disputed',  gen_random_uuid(), 'casual',         'f','disputed', 'confirmed','f');

INSERT INTO players (id, email, first_name) VALUES
 ('aaaaaaaa-0000-4000-8000-000000000001','arms-harness-1@example.invalid','ArmsOne'),
 ('aaaaaaaa-0000-4000-8000-000000000002','arms-harness-2@example.invalid','ArmsTwo');
INSERT INTO ratings (player_id, singles_elo) VALUES
 ('aaaaaaaa-0000-4000-8000-000000000001',1000),
 ('aaaaaaaa-0000-4000-8000-000000000002',1000);

INSERT INTO matches (id, match_type, event_type, rated_flag, format, result_status, submitted_by, played_at)
SELECT m,'singles',ev,rated,'single_21',st,'aaaaaaaa-0000-4000-8000-000000000001'::uuid,NOW() FROM cases;

-- rating_delta is set on every case so that a reversal, if one happens, is
-- visible in `ratings` and not merely inferred from an audit row.
INSERT INTO match_participants (match_id,player_id,team_side,pre_rating,post_rating,rating_delta,
                                points_scored,points_allowed,games_won,games_lost,win_flag)
SELECT m,'aaaaaaaa-0000-4000-8000-000000000001'::uuid,'a'::team_side, 990,1000, 10,21,15,1,0,true  FROM cases
UNION ALL
SELECT m,'aaaaaaaa-0000-4000-8000-000000000002'::uuid,'b'::team_side,1010,1000,-10,15,21,0,1,false FROM cases;

DO $$
DECLARE c RECORD; got RECORD; n_audit int; n_rev int; ok boolean := true;
BEGIN
  FOR c IN SELECT * FROM cases ORDER BY tag LOOP
    PERFORM convert_club_match_to_casual(c.m,'aaaaaaaa-0000-4000-8000-000000000001','harness: '||c.tag);

    SELECT result_status, event_type, rated_flag INTO got FROM matches WHERE id = c.m;
    SELECT count(*) INTO n_audit FROM audit_logs
      WHERE target_id = c.m AND action_type = 'match_converted_casual';
    SELECT count(*) INTO n_rev   FROM audit_logs
      WHERE target_id = c.m AND action_type = 'match_reversed';

    IF got.result_status <> c.want_status THEN
      RAISE WARNING '% : status % expected %', c.tag, got.result_status, c.want_status; ok := false;
    END IF;
    -- Every arm ends casual and unrated. An arm that skipped the flags is the
    -- H1 mutation, and this is what catches it.
    IF got.event_type <> 'casual' OR got.rated_flag THEN
      RAISE WARNING '% : left as %/rated=%', c.tag, got.event_type, got.rated_flag; ok := false;
    END IF;
    IF (n_rev > 0) <> c.want_reversed THEN
      RAISE WARNING '% : reversed=% expected %', c.tag, (n_rev > 0), c.want_reversed; ok := false;
    END IF;
    -- Exactly one, including for the fall-through arm: the note and the audit
    -- row are the reason arm 1 is not an early return.
    IF n_audit <> 1 THEN
      RAISE WARNING '% : % convert audit rows, expected 1', c.tag, n_audit; ok := false;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM match_admin_notes WHERE match_id = c.m AND note = 'harness: '||c.tag) THEN
      RAISE WARNING '% : note missing', c.tag; ok := false;
    END IF;
  END LOOP;

  IF NOT ok THEN RAISE EXCEPTION '00203 arms: FAILED (see warnings above)'; END IF;
  RAISE NOTICE '00203 arms: 6/6 cases correct (all four arms, incl. fall-through and always-casual)';
END $$;

-- Exactly one match was ever reversed (A3), so exactly one delta came back out.
DO $$
DECLARE a int; b int;
BEGIN
  SELECT singles_elo INTO a FROM ratings WHERE player_id='aaaaaaaa-0000-4000-8000-000000000001';
  SELECT singles_elo INTO b FROM ratings WHERE player_id='aaaaaaaa-0000-4000-8000-000000000002';
  IF a <> 990 OR b <> 1010 THEN
    RAISE EXCEPTION '00203 arms: ratings %/% expected 990/1010 — a reversal ran on the wrong number of cases', a, b;
  END IF;
  RAISE NOTICE '00203 arms: exactly one reversal applied, to the confirmed case only';
END $$;

-- ============================================================
-- void_club_match, called DIRECTLY
-- ============================================================
--
-- The standalone Void button on /matches does not go through a dispute, so it
-- inherits none of the coverage below. Its two states are asserted here.

CREATE TEMP TABLE v(tag text, m uuid, st result_status, want_reversed bool) ON COMMIT DROP;
INSERT INTO v VALUES
 ('V1 confirmed -> reversed and voided', gen_random_uuid(), 'confirmed','t'),
 ('V2 already voided -> no reversal',    gen_random_uuid(), 'voided',   'f');

INSERT INTO matches (id, match_type, event_type, rated_flag, format, result_status, submitted_by, played_at)
SELECT m,'singles','rated_challenge',true,'single_21',st,'aaaaaaaa-0000-4000-8000-000000000001'::uuid,NOW() FROM v;
INSERT INTO match_participants (match_id,player_id,team_side,pre_rating,post_rating,rating_delta,
                                points_scored,points_allowed,games_won,games_lost,win_flag)
SELECT m,'aaaaaaaa-0000-4000-8000-000000000001'::uuid,'a'::team_side, 990,1000, 10,21,15,1,0,true  FROM v
UNION ALL
SELECT m,'aaaaaaaa-0000-4000-8000-000000000002'::uuid,'b'::team_side,1010,1000,-10,15,21,0,1,false FROM v;

DO $$
DECLARE c RECORD; st result_status; ev event_type_enum; n_rev int; n_audit int; ok boolean := true;
BEGIN
  FOR c IN SELECT * FROM v ORDER BY tag LOOP
    PERFORM void_club_match(c.m,'aaaaaaaa-0000-4000-8000-000000000001','void reason '||c.tag);

    SELECT result_status, event_type INTO st, ev FROM matches WHERE id = c.m;
    SELECT count(*) INTO n_rev   FROM audit_logs WHERE target_id = c.m AND action_type = 'match_reversed';
    SELECT count(*) INTO n_audit FROM audit_logs WHERE target_id = c.m AND action_type = 'match_voided';

    IF st <> 'voided' THEN RAISE WARNING '% : status %', c.tag, st; ok := false; END IF;
    -- A void must NOT reclassify. Only Convert does that, and a void that
    -- quietly turned a rated match casual would erase it from the ladder.
    IF ev <> 'rated_challenge' THEN RAISE WARNING '% : reclassified to %', c.tag, ev; ok := false; END IF;
    IF (n_rev > 0) <> c.want_reversed THEN
      RAISE WARNING '% : reversed=% expected %', c.tag, (n_rev > 0), c.want_reversed; ok := false;
    END IF;
    IF n_audit <> 1 THEN RAISE WARNING '% : % match_voided rows, expected 1', c.tag, n_audit; ok := false; END IF;
    IF NOT EXISTS (SELECT 1 FROM match_admin_notes WHERE match_id = c.m AND note = 'void reason '||c.tag) THEN
      RAISE WARNING '% : note missing', c.tag; ok := false;
    END IF;
  END LOOP;

  IF NOT ok THEN RAISE EXCEPTION '00203 void: FAILED (see warnings above)'; END IF;
  RAISE NOTICE '00203 void: direct void correct for both states, and never reclassifies';
END $$;

-- ============================================================
-- The dispute entry point
-- ============================================================

CREATE TEMP TABLE d(tag text, m uuid, dsp uuid, res dispute_resolution) ON COMMIT DROP;
INSERT INTO d VALUES
 ('D1 voided',              gen_random_uuid(), gen_random_uuid(), 'voided'),
 ('D2 converted_to_casual', gen_random_uuid(), gen_random_uuid(), 'converted_to_casual');

INSERT INTO matches (id, match_type, event_type, rated_flag, format, result_status, submitted_by, played_at)
SELECT m,'singles','rated_challenge',true,'single_21','confirmed','aaaaaaaa-0000-4000-8000-000000000001'::uuid,NOW() FROM d;
INSERT INTO match_participants (match_id,player_id,team_side,pre_rating,post_rating,rating_delta,
                                points_scored,points_allowed,games_won,games_lost,win_flag)
SELECT m,'aaaaaaaa-0000-4000-8000-000000000001'::uuid,'a'::team_side, 990,1000, 10,21,15,1,0,true  FROM d
UNION ALL
SELECT m,'aaaaaaaa-0000-4000-8000-000000000002'::uuid,'b'::team_side,1010,1000,-10,15,21,0,1,false FROM d;
INSERT INTO disputes (id, match_id, opened_by, reason_category, description, status)
SELECT dsp, m, 'aaaaaaaa-0000-4000-8000-000000000002'::uuid, 'score_wrong'::dispute_reason, 'harness', 'open'::dispute_status FROM d;

DO $$
DECLARE c RECORD; first jsonb; second jsonb; st dispute_status; n_disp int; n_match int; note text; ok boolean := true;
BEGIN
  FOR c IN SELECT * FROM d ORDER BY tag LOOP
    first  := resolve_dispute_unrated(c.dsp,'aaaaaaaa-0000-4000-8000-000000000001',c.res,'harness note '||c.tag);
    -- THE IDEMPOTENCE KEY. A second attempt must change nothing at all — not
    -- the dispute, not the match, not the audit trail, and not the note.
    second := resolve_dispute_unrated(c.dsp,'aaaaaaaa-0000-4000-8000-000000000001',c.res,'SECOND ATTEMPT');

    IF (first->>'applied') <> 'true' THEN
      RAISE WARNING '% : first call did not apply (%)', c.tag, first; ok := false;
    END IF;
    IF (second->>'already_resolved') <> 'true' OR (second->>'applied') <> 'false' THEN
      RAISE WARNING '% : second call was not a no-op (%)', c.tag, second; ok := false;
    END IF;

    SELECT status INTO st FROM disputes WHERE id = c.dsp;
    IF st <> 'resolved' THEN RAISE WARNING '% : dispute left %', c.tag, st; ok := false; END IF;

    SELECT count(*) INTO n_disp  FROM audit_logs WHERE target_id = c.dsp AND action_type = 'dispute_resolved';
    SELECT count(*) INTO n_match FROM audit_logs WHERE target_id = c.m
       AND action_type IN ('match_voided','match_converted_casual');
    -- One each, after TWO calls. This is the assertion that catches a double
    -- audit row — the failure mode a boolean threaded back to TypeScript to
    -- decide whether to log would produce, invisibly.
    IF n_disp <> 1 THEN RAISE WARNING '% : % dispute_resolved rows, expected 1', c.tag, n_disp; ok := false; END IF;
    IF n_match <> 1 THEN RAISE WARNING '% : % match audit rows, expected 1', c.tag, n_match; ok := false; END IF;

    SELECT n.note INTO note FROM match_admin_notes n WHERE n.match_id = c.m;
    IF note <> 'harness note '||c.tag THEN
      RAISE WARNING '% : note is %, the second attempt overwrote it', c.tag, note; ok := false;
    END IF;
  END LOOP;

  IF NOT ok THEN RAISE EXCEPTION '00203 dispute: FAILED (see warnings above)'; END IF;
  RAISE NOTICE '00203 dispute: both resolutions apply once and are idempotent on retry';
END $$;

-- ============================================================
-- Refusals
-- ============================================================

DO $$
DECLARE refused boolean; ok boolean := true;
BEGIN
  -- A rated resolution must not be served by the unrated function: it would
  -- close the dispute without ever applying the result.
  refused := false;
  BEGIN PERFORM resolve_dispute_unrated(gen_random_uuid(),NULL,'accepted','x');
  EXCEPTION WHEN others THEN refused := true; END;
  IF NOT refused THEN RAISE WARNING 'R1: accepted was not refused'; ok := false; END IF;

  -- The note is the reason of record for both the match note and the audit
  -- row. Neither is worth writing empty.
  refused := false;
  BEGIN PERFORM resolve_dispute_unrated(gen_random_uuid(),NULL,'voided','   ');
  EXCEPTION WHEN others THEN refused := true; END;
  IF NOT refused THEN RAISE WARNING 'R2: blank note was not refused'; ok := false; END IF;

  refused := false;
  BEGIN PERFORM resolve_dispute_unrated(gen_random_uuid(),NULL,'voided',NULL);
  EXCEPTION WHEN others THEN refused := true; END;
  IF NOT refused THEN RAISE WARNING 'R3: NULL note was not refused'; ok := false; END IF;

  refused := false;
  BEGIN PERFORM resolve_dispute_unrated(gen_random_uuid(),NULL,'voided','a real note');
  EXCEPTION WHEN others THEN refused := true; END;
  IF NOT refused THEN RAISE WARNING 'R4: unknown dispute was not refused'; ok := false; END IF;

  IF NOT ok THEN RAISE EXCEPTION '00203 refusals: FAILED (see warnings above)'; END IF;
  RAISE NOTICE '00203 refusals: 4/4 refused';
END $$;

ROLLBACK;

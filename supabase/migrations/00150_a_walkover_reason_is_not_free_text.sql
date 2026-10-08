-- ============================================================
-- 00150_a_walkover_reason_is_not_free_text.sql — the fifth free-text column,
-- the one four "note" sweeps walked past
-- ============================================================
-- APPLY THIS *AFTER* THE APP DEPLOY THAT CARRIES THE MATCHING COMMIT. Not
-- before, and this is the only file in the current batch with a hard order in
-- that direction. The CHECK constraint at the bottom bounds what may be written
-- to `tournament_matches.walkover_reason`; the build running in production
-- today writes the exec's typed sentence there, so applying this first turns
-- every walkover entry into a constraint violation — a red toast at the desk in
-- the middle of a tournament. The app change is inert against a database
-- without this file (it simply writes one of three phrases), so app-first is
-- safe in a way database-first is not.
--
-- ------------------------------------------------------------
-- WHAT WAS LEAKING
-- ------------------------------------------------------------
-- 00117, 00118, 00122 and 00125 swept exec free text off five member-readable
-- rows and into private tables. All four passes were scoped by the word "note",
-- and this column is called `reason`, so none of them looked at it. What sits
-- in it is the sentence an exec types into the walkover panel of
-- ScoreEntryDialog — the same panel, on the same dialog, whose void,
-- double-no-show and restore boxes were all privatised by 00118.
--
-- It is worse here than at most of those sites, for a reason specific to this
-- table: 00113 publishes `tournament_matches` to `supabase_realtime`, and
-- LOGICAL REPLICATION IGNORES COLUMN GRANTS. Revoking the column would not have
-- helped; every phone with the bracket open received the whole row, sentence
-- included, the instant the walkover was recorded. On top of that the column is
-- plainly readable through PostgREST by any signed-in member — the player app
-- does not select it, but nothing stops a `curl` that does.
--
-- ------------------------------------------------------------
-- WHY BOUND IT INSTEAD OF MOVING ALL OF IT
-- ------------------------------------------------------------
-- Because a walkover that appears on the bracket with no explanation is worse
-- for the opponent than one that says why. The withdrawal cascade already
-- writes one of two canned sentences ("Opponent withdrew from the event",
-- "Opponent was disqualified") and those ARE the feature — they are the same
-- fact the draw shows anyway, in words.
--
-- This is 00135's decision about `court`, applied in the same direction:
-- broadcasting a bounded fact is fine, broadcasting unbounded exec prose is
-- not. So the column keeps a three-word vocabulary and the exec's own sentence
-- goes to `tournament_match_notes`, which 00118 created for exactly this and
-- which is private, ungranted, and NOT in the publication.
--
-- ------------------------------------------------------------
-- ORDER INSIDE THE FILE
-- ------------------------------------------------------------
-- Backfill, then normalise, then constrain. The constraint cannot be added
-- first (existing rows would fail it) and the normalise cannot run first (it
-- would destroy the text the backfill is there to preserve).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Preserve what is already written.
-- ------------------------------------------------------------
-- ON CONFLICT DO NOTHING, NOT DO UPDATE. `tournament_match_notes` is keyed by
-- match_id and holds one note per match. A match that already HAS a note has
-- one because it was voided, no-showed or restored — all of which happen after
-- the walkover — so the existing row is the more recent statement about that
-- match and must not be overwritten by a sentence from before it.
--
-- author_id is NULL rather than guessed. `result_entered_by` is the exec who
-- recorded the walkover and is very probably the author, but "very probably" is
-- not a provenance, and the column is nullable precisely so this file does not
-- have to invent one. 00118 recovered a real author for walkover_admin_notes
-- only because a single statement wrote both values there.
INSERT INTO public.tournament_match_notes (match_id, note, author_id, created_at, updated_at)
SELECT
  m.id,
  m.walkover_reason,
  NULL,
  COALESCE(m.result_entered_at, m.updated_at, NOW()),
  COALESCE(m.result_entered_at, m.updated_at, NOW())
FROM public.tournament_matches m
WHERE m.walkover_reason IS NOT NULL
  AND btrim(m.walkover_reason) <> ''
  AND m.walkover_reason NOT IN (
    'Opponent withdrew from the event',
    'Opponent was disqualified',
    'Walkover awarded by the desk'
  )
ON CONFLICT (match_id) DO NOTHING;

-- ------------------------------------------------------------
-- 2. Normalise the column to the vocabulary.
-- ------------------------------------------------------------
-- Everything that is not already one of the three phrases becomes the desk
-- phrase, because that is what it was: a walkover an exec awarded by hand.
-- Blank strings become NULL — the column has always been nullable and '' never
-- meant anything.
UPDATE public.tournament_matches
   SET walkover_reason = NULL
 WHERE walkover_reason IS NOT NULL
   AND btrim(walkover_reason) = '';

UPDATE public.tournament_matches
   SET walkover_reason = 'Walkover awarded by the desk'
 WHERE walkover_reason IS NOT NULL
   AND walkover_reason NOT IN (
     'Opponent withdrew from the event',
     'Opponent was disqualified',
     'Walkover awarded by the desk'
   );

-- ------------------------------------------------------------
-- 3. Make it impossible to put prose back.
-- ------------------------------------------------------------
-- A CHECK rather than an enum or a lookup table. An enum would need a type, a
-- cast on the column, and its own migration discipline for every future value;
-- a lookup table would need a foreign key and a join on the hottest read in the
-- tournament app. The vocabulary is three fixed English sentences that the
-- application already holds as a literal union (PUBLIC_WALKOVER_REASONS in
-- apps/admin/src/lib/tournament-actions/_internal.ts), and a CHECK is the
-- narrowest thing that keeps the two in step.
--
-- Added valid in one statement rather than NOT VALID + VALIDATE: step 2 above
-- has just guaranteed every row passes, and this table is a few thousand rows
-- on the largest tournament the club has ever run, so the ACCESS EXCLUSIVE lock
-- is measured in milliseconds. If that ever stops being true, split it.
ALTER TABLE public.tournament_matches
  DROP CONSTRAINT IF EXISTS tournament_matches_walkover_reason_bounded;

ALTER TABLE public.tournament_matches
  ADD CONSTRAINT tournament_matches_walkover_reason_bounded
  CHECK (
    walkover_reason IS NULL
    OR walkover_reason IN (
      'Opponent withdrew from the event',
      'Opponent was disqualified',
      'Walkover awarded by the desk'
    )
  );

COMMENT ON COLUMN public.tournament_matches.walkover_reason IS
  'Why this match was a walkover, in one of three fixed phrases — never free text. Bounded by tournament_matches_walkover_reason_bounded and mirrored by PUBLIC_WALKOVER_REASONS in the console. This table is published to supabase_realtime and logical replication ignores column grants, so anything written here is delivered to every phone watching the bracket; that is fine for a canned phrase and was not fine for the sentence an exec typed, which is what this column held until 00150 moved it to tournament_match_notes. The two "Opponent …" phrases are written by the withdrawal/disqualification cascade and are deliberately public — an unexplained walkover is worse for the opponent than an explained one. NULL is legal and means a walkover recorded before any of this existed.';

COMMENT ON TABLE public.tournament_match_notes IS
  'Exec-written reason a tournament match was voided, recorded as a double no-show, restored, or awarded as a walkover. PRIVATE: no grant for anon/authenticated, RLS on with no policy, NOT published to supabase_realtime — 00113 publishes tournament_matches, so this text streamed to every subscriber until it moved here. Gated on tournaments.results.void.write / .doublenoshow.write / .unvoid.write / .walkover.write. Superseded tournament_matches.notes, which 00122 dropped once no deployed build selected it, and tournament_matches.walkover_reason''s free-text half, which 00150 bounded.';

COMMIT;

-- ============================================================
-- AFTERWARDS
-- ============================================================
-- Nothing to verify by eye on the console: the walkover summary line in
-- ScoreEntryDialog now prefers the private note and falls back to the bounded
-- phrase, so an authorised exec sees the same words they typed either way.
--
-- To confirm the leak is closed, from a MEMBER's key rather than the service
-- role:
--   select walkover_reason, count(*) from tournament_matches
--    where walkover_reason is not null group by 1;
-- Three rows at most, all of them phrases, none of them anybody's prose.
-- ============================================================

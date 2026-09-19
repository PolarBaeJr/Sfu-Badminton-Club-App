-- ============================================================
-- 00233_purgeable_unfinished_signups.sql: ONE definition of who
-- is an abandoned signup stub and may simply be deleted
--
-- Same shape and the same reasoning as 00064: the eligibility
-- predicate for a destructive retention job lives in a view and
-- nowhere else, so the dry run, the real run and any hand-written
-- "who would this hit tonight?" query all answer out of one WHERE
-- clause. 00064:13-21 explains why this belongs in SQL rather than
-- supabase/functions/_shared/: that directory deploys by rsync and
-- carries constants that differ between repo and prod, so putting a
-- deletion predicate there would make correct deployment depend on a
-- sync that is independently dangerous. Unchanged here.
--
-- WHAT IS DIFFERENT FROM ITS TWIN. purge-inactive-accounts
-- ANONYMISES because a lapsed member is woven into the record of
-- every match they played (purge-inactive-accounts:7-16). A row that
-- matches THIS view has played nothing and is nobody: no name, no
-- waiver, no matches. There is nothing to preserve and no reason to
-- keep a permanent "Deleted Player" tombstone for somebody who never
-- arrived, so the job deletes the row outright. That is also why no
-- email is ever sent: there is no member to notify, only an address
-- that proved itself once and then walked away.
--
-- ------------------------------------------------------------
-- first_name = '' IS THE LOAD-BEARING CONDITION. IF A FUTURE EDIT
-- DROPS IT, THIS JOB DELETES REAL MEMBERS.
-- ------------------------------------------------------------
-- `user_id IS NOT NULL AND onboarding_completed = FALSE` is the
-- repo's existing definition of an incomplete signup: it is the
-- Incomplete tab's list filter (apps/admin/src/app/players/page.tsx:225)
-- and its headcount predicate (:284-285). On its own, as a DELETE
-- predicate, IT IS A ROSTER SHREDDER.
--
-- The claim arm of ensure_player_for_user
-- (00132_player_row_at_first_signin.sql:389-395) attaches user_id to a
-- roster row an exec pre-added, and writes NOTHING else but
-- updated_at. :385-388 says why onboarding_completed is deliberately
-- left FALSE: the claim now happens at SIGN-IN, before any name or
-- waiver, and setting it there would walk the member straight past the
-- onboarding gate. created_at is not touched either, because the row
-- was inserted by the exec months earlier. So a member pre-added in
-- January who signs in for the first time in September and closes the
-- tab matches `user_id IS NOT NULL AND NOT onboarding_completed` with
-- an EIGHT-MONTH-OLD created_at: already past the 30 days, deleted on
-- the very first armed run, along with every other pre-add who ever
-- did the same.
--
-- first_name = '' is the one condition that separates a true stub from
-- that row:
--
--   * ensure_player_for_user inserts stubs with first_name = ''
--     literally (00132:530-531). Only the stub path produces it.
--   * apps/player/src/lib/actions/profile.ts:515-516 states the rule
--     outright: "A STUB, on the other hand, has first_name = '' and
--     this is the only thing that ever fills it". So a blank name
--     means onboarding has never run to completion, and completing it
--     fills the name in the same act.
--   * An admin pre-add can never produce ''.
--     packages/shared/src/validators/schemas.ts:23 is
--     `z.string().min(1, 'First name is required')` and
--     adminPlayerCreateSchema uses it for first_name (:430), so the
--     console cannot write an empty one.
--
-- NULL is excluded too, and that is the safe direction. first_name is
-- nullable (00023_split_player_name.sql:23), and `NULL = ''` is NULL,
-- not true, so a row with a NULL name is KEPT rather than deleted.
-- That is 00064's positive-guard posture (00064:5-11): every arm here
-- has to be affirmatively true for a row to be erased, so a column
-- that is unexpectedly NULL saves the row instead of costing it. This
-- is why the condition is not COALESCE(first_name, '') = ''.
--
-- WHAT IS CARRIED FROM 00064, FOR ITS REASONS:
--
--   is_banned = FALSE            The club owner's instruction about
--     suspension (00064:39-43). A banned row must not be swept up by a
--     clock, and deleting it would destroy the record of who was
--     banned and what for. It also cannot be a stub: banning is an
--     exec act against somebody who existed.
--
--   deletion_requested_at IS NULL  That is the 30-day consent flow in
--     purge-deleted-accounts, with its own notice and its own grace
--     period (00064:45-48). Two jobs racing for one row is how one of
--     them ends up half-done, and here one of them DELETES.
--
--   role = 'player', is_exec = FALSE, is_trainer = FALSE
--     The people who run and coach the club (00064:33-37). Stated as a
--     positive match on 'player' rather than 00064's `role <> 'admin'`
--     because this predicate deletes: anything that is not plainly an
--     ordinary member is out. A privileged row reaching here would
--     mean a stub got promoted before it was ever filled in, which is
--     not a situation to resolve by deletion.
--
--   privilege_claim_review IS NULL  00132:189. A pending claim review
--     is an exec decision that has been recorded and not yet made, on
--     a row whose privileges were withheld at claim time. Deleting the
--     row deletes the question.
--
-- WHY NOT platform_settings / inactivity_rules. 30 days is written
-- here as a literal on purpose. inactivity_rules.purge_after_days is
-- the retention period for a LAPSED MEMBER (365 by default, floored at
-- 30 by 00064:84) and the console field that edits it is labelled as
-- such. "How long do we hold an abandoned signup stub?" is a different
-- policy about a different kind of row, and wiring it to the same
-- number would mean an exec shortening member retention silently
-- shortened this too, or lengthening it silently parked thousands of
-- stubs. If the club ever wants this configurable it gets its own key,
-- and 00064's GREATEST floor is the pattern to copy when it does.
--
-- NOT EXISTS on match_participants is belt-and-braces rather than the
-- main guard: a stub has no name and cannot be put in a match by the
-- console, but a row that HAS played is by definition part of the
-- match record 00064 exists to protect. It also doubles as the reason
-- the job need not pre-delete dependent rows: see
-- purge-unfinished-signups/index.ts.
-- ============================================================

CREATE OR REPLACE VIEW purgeable_unfinished_signups AS
SELECT
  p.id,
  p.user_id,
  -- Returned so the job can log WHY without recomputing the cutoff, and
  -- because created_at is the whole clock here: nothing re-stamps it after the
  -- stub is inserted, so it is the moment of first sign-in.
  p.created_at
FROM players p
WHERE p.user_id IS NOT NULL
  AND p.onboarding_completed = FALSE
  -- READ THE HEADER BEFORE TOUCHING THIS LINE.
  AND p.first_name = ''
  AND p.created_at < NOW() - INTERVAL '30 days'
  -- A row that has appeared in a match is part of the record, never a stub.
  AND NOT EXISTS (
    SELECT 1 FROM match_participants mp WHERE mp.player_id = p.id
  )
  AND p.is_banned = FALSE
  AND p.deletion_requested_at IS NULL
  AND p.role = 'player'
  AND p.is_exec = FALSE
  AND p.is_trainer = FALSE
  AND p.privilege_claim_review IS NULL;

COMMENT ON VIEW purgeable_unfinished_signups IS
  'Abandoned signup stubs eligible for outright DELETION: signed in (user_id) more than 30 days ago, never finished onboarding, and still carrying the empty first_name that ensure_player_for_user (00132) seeds and only onboarding ever fills. first_name = '''' is what distinguishes a stub from an exec pre-added roster row claimed at first sign-in, which matches the other arms with an arbitrarily old created_at. Excludes banned, deletion-pending, privileged and claim-review rows, and anybody who has played a match. Single source of truth for purge-unfinished-signups. Service role only.';

-- Same posture as purgeable_inactive_players (00064:106-110) and cron_config
-- (00061): the view names the rows that are about to be erased, which is not a
-- members'-app read. Only the service key, which is what the edge function
-- holds.
REVOKE ALL ON purgeable_unfinished_signups FROM PUBLIC, anon, authenticated;
GRANT SELECT ON purgeable_unfinished_signups TO service_role;

-- PostgREST caches the schema and the edge function reaches this view through
-- PostgREST (supabase.from('purgeable_unfinished_signups')). Without this the
-- view exists in Postgres but the job gets PGRST205 "table not found", which
-- looks exactly like "the purge found nobody", the one failure mode that is
-- indistinguishable from success (00064:112-119). Cheap and idempotent, so it
-- runs here rather than being a step somebody has to remember.
NOTIFY pgrst, 'reload schema';

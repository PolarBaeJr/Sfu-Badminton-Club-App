-- ============================================================
-- 00064_purgeable_inactive_players.sql — ONE definition of who
-- may be anonymised for inactivity
--
-- This view is the whole safety argument for the retention job.
-- Every exclusion the club agreed to lives here and nowhere else,
-- so the nightly job, the dry run, and the "how many today?"
-- question are all answering out of the same WHERE clause. A
-- second copy of these predicates in TypeScript is exactly the
-- defect this avoids: the copies drift, and the direction they
-- drift in deletes somebody.
--
-- WHY SQL AND NOT supabase/functions/_shared/.
-- Edge functions here deploy by rsync into a bind mount, one
-- directory at a time, and _shared/ carries constants that differ
-- between repo and prod — a wholesale sync of it flips DEFAULT_ELO
-- and silently rewrites season compression. Putting the predicate
-- in a shared TS module would make correct deployment of the purge
-- depend on an rsync that is independently dangerous. In the
-- database it is deployed by the migration itself, and psql can
-- exercise it directly inside BEGIN; ... ROLLBACK;.
--
-- WHAT IS EXCLUDED, AND WHY EACH ONE:
--
--   inactive_since IS NOT NULL   Only a CLOCK-DRIVEN lapse starts
--     the retention countdown. An exec who unticks "active" by hand
--     in the console does not stamp inactive_since, so that row is
--     never purgeable. This is deliberate, not an oversight: a
--     manual deactivation is a human decision with a reason nobody
--     wrote down, and a year later there is no way to tell it from
--     a lapse. The safe reading is "leave it alone".
--
--   role <> 'admin', NOT is_exec   The people who run the club.
--     Same exemption mark-inactive-players applies upstream, for
--     the same reason (an exec may legitimately not play for a
--     term) — repeated here because a row deactivated BEFORE
--     somebody was made an exec would otherwise still be eligible.
--
--   NOT is_banned                The club owner's instruction about
--     suspension: a banned member must not be swept up by an
--     inactivity clock, "since they may get removed from
--     suspended". Anonymising them would also destroy the record of
--     who was banned and what for.
--
--   deletion_requested_at IS NULL  That is the 30-day flow in
--     purge-deleted-accounts, with its own consent, its own notice
--     and its own grace period. Two jobs racing for the same row is
--     how one of them ends up half-done.
--
--   status NOT IN (...)          An admin removal writes
--     status='suspended' + active_flag=false; pending_approval
--     never joined. Neither is a lapse. Mirrors isSelfReactivatable
--     in packages/shared, which is the same discrimination made for
--     the members' app.
--
--   email NOT LIKE 'deleted+%'   IDEMPOTENCY. Anonymising does not
--     change active_flag or inactive_since, so without this the row
--     matches again tomorrow and every night after — re-anonymising
--     a row that is already anonymous and writing a fresh audit row
--     for it forever. purge-deleted-accounts guards itself the same
--     way with the same sentinel.
--
-- Reactivation is handled by active_flag alone: every path that
-- puts somebody back on the roster sets active_flag=true AND clears
-- inactive_since, so "reactivated since" fails two tests here.
-- ============================================================

CREATE OR REPLACE VIEW purgeable_inactive_players AS
SELECT
  p.id,
  p.user_id,
  p.inactive_since,
  -- Returned so the job can log WHY without recomputing the cutoff.
  (SELECT COALESCE((value ->> 'purge_after_days')::INT, 365)
     FROM platform_settings WHERE key = 'inactivity_rules') AS purge_after_days
FROM players p
WHERE p.active_flag = FALSE
  AND p.inactive_since IS NOT NULL
  AND p.inactive_since < NOW() - (
        -- Threshold from settings, never a literal, so the job and the
        -- notice email cannot disagree about the retention period.
        -- COALESCE covers a settings row that predates 00063.
        (SELECT COALESCE((value ->> 'purge_after_days')::INT, 365)
           FROM platform_settings WHERE key = 'inactivity_rules')
      ) * INTERVAL '1 day'
  AND p.role <> 'admin'
  AND p.is_exec = FALSE
  AND p.is_banned = FALSE
  AND p.deletion_requested_at IS NULL
  AND p.status NOT IN ('suspended', 'pending_approval')
  AND (p.email IS NULL OR p.email NOT LIKE 'deleted+%@deleted.invalid');

COMMENT ON VIEW purgeable_inactive_players IS
  'Members eligible for inactivity anonymisation: lapsed by the clock (inactive_since) longer ago than inactivity_rules.purge_after_days, excluding admins, execs, banned, deletion-pending, suspended/pending, and rows already anonymised. Single source of truth for purge-inactive-accounts. Service role only.';

-- Same posture as cron_config (00061): the view exposes who is about
-- to lose their personal details, which is not a members'-app read.
-- Only the service key, which is what the edge function holds.
REVOKE ALL ON purgeable_inactive_players FROM PUBLIC, anon, authenticated;
GRANT SELECT ON purgeable_inactive_players TO service_role;

-- PostgREST caches the schema, and the edge function reaches this view through
-- PostgREST (supabase.from('purgeable_inactive_players')). Without this the
-- view exists in Postgres but the job gets PGRST205 "table not found" until
-- something else happens to reload the cache — which would look exactly like
-- "the purge found nobody", the one failure mode that is indistinguishable
-- from success. Cheap and idempotent, so it runs here rather than being a step
-- somebody has to remember.
NOTIFY pgrst, 'reload schema';

-- 00157 — the grants staging kept and prod did not
--
-- SAFE TO APPLY AT ANY TIME, ON BOTH DATABASES. Nothing in either app reads any
-- of these four through a member's key — every reader is on the service role,
-- checked one by one below — so this cannot 403 a screen. On prod it is very
-- nearly a no-op and applying it is how prod stops depending on that.
--
-- WHAT THIS IS. The member-privacy audit compared prod's and staging's
-- catalogues relation by relation. Four relations hold a grant on STAGING that
-- prod does not have, and that the migrations never asked for. They are drift:
-- somebody's `GRANT ... ON ALL TABLES IN SCHEMA public`, or a hand-run
-- statement, that prod happened to escape. Only the first is live.
--
--   purgeable_inactive_players  authenticated=rm  -- LIVE. A VIEW, so RLS does
--                                                    not apply to it, and it
--                                                    carries no
--                                                    security_invoker option so
--                                                    it defaults to FALSE and
--                                                    runs as postgres. Both the
--                                                    row policies and the
--                                                    column grants on `players`
--                                                    are therefore bypassed,
--                                                    and any signed-in member on
--                                                    staging can read the club's
--                                                    PURGE QUEUE: id, user_id,
--                                                    inactive_since (a column
--                                                    with no grant of its own)
--                                                    and purge_after_days, for
--                                                    every member queued for
--                                                    deletion.
--   email_suppressions          SELECT (email, …)  -- inert TODAY
--   cron_config                 SELECT (key, value)-- inert TODAY
--   tournament_checkin_tokens   SELECT (token, …)  -- inert TODAY
--
-- WHY THE OTHER THREE ARE INERT, AND WHY THEY ARE REVOKED ANYWAY. All three are
-- TABLES with RLS ENABLED AND ZERO POLICIES. RLS on with no policy denies every
-- row, so the column grant currently buys a member nothing — which is exactly
-- why they survived the drift and the view did not. They are one accidental
-- `CREATE POLICY ... USING (true)` away from being live, and
-- `email_suppressions.email` is the one column in this whole audit that would
-- take a member's contact details straight past 00032. A grant that is only
-- harmless because of a second control is a grant to remove.
--
-- 00064:109-110 ALREADY SAYS THE FIRST ONE. This file is not new policy; it is
-- the existing intent re-stated so that a database which drifted away from it
-- comes back, and so that the next `ALL TABLES` grant does not silently
-- reinstate it without anyone noticing the file that says otherwise.
--
-- EVERY ROLE IS NAMED, not just PUBLIC. 00134 found that `REVOKE ... FROM
-- PUBLIC` alone did not clear a grant held by `authenticated` in its own right
-- — PUBLIC is not a parent of the other roles, it is a separate grantee — and
-- had to name them. Same here.
--
-- THE READERS, checked before writing this:
--
--   purgeable_inactive_players  supabase/functions/purge-inactive-accounts
--                               — edge function, service role
--   email_suppressions          packages/shared/src/email/sender.ts (getAdmin),
--                               apps/player/src/app/unsubscribe/route.ts,
--                               the resend and ses webhook routes
--                               — all createServiceRoleClient / getAdmin
--   cron_config                 apps/admin/src/app/api/cron/weekly-digest
--                               — createAdminClient
--   tournament_checkin_tokens   apps/admin/src/lib/actions/tournament-checkin.ts,
--                               apps/player/src/lib/tournament-checkin.ts
--                               — the player one is explicitly service role and
--                                 says so in a comment, because this table has
--                                 had RLS-on-no-policy since 00045
--
-- A REVOKE THAT IS WRONG DOES NOT ERROR — it empties a list. That is why the
-- readers were enumerated rather than assumed: sender.ts reads
-- email_suppressions to decide whether to send, and a 403 there arrives as
-- `data: null`, which without its error check would have read as "not
-- suppressed" and mailed the address anyway. It has that check (00136), and
-- this file does not rely on it.

BEGIN;

REVOKE ALL PRIVILEGES ON TABLE public.purgeable_inactive_players FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.email_suppressions         FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.cron_config                FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.tournament_checkin_tokens  FROM PUBLIC, anon, authenticated;

-- Re-stated rather than assumed: the service role is what every reader above
-- actually uses, and a REVOKE that also took this away would break the purge
-- job, the unsubscribe route and tournament check-in at once.
GRANT SELECT ON public.purgeable_inactive_players TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- VERIFY (as the owner, after applying — run on BOTH databases):
--
--   SELECT relname, relacl FROM pg_class
--    WHERE relname IN ('purgeable_inactive_players','email_suppressions',
--                      'cron_config','tournament_checkin_tokens');
--
--   -- no `authenticated=` and no `anon=` entry should remain on any of the
--   -- four. service_role keeps arwdDxtm on the three tables and SELECT on the
--   -- view.
--
--   -- and, still on staging, as an ordinary member — this must now be 403 or
--   -- empty rather than the purge queue:
--   curl -H "apikey: $ANON" -H "Authorization: Bearer $MEMBER_JWT" \
--     "$SUPABASE_URL/rest/v1/purgeable_inactive_players?select=user_id,inactive_since"

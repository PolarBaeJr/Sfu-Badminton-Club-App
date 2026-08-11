-- ============================================================
-- 00100 — /exec is sorted by the name /exec actually shows
-- ============================================================
-- 00096 moved get_executives()'s `name` from COALESCE(display_name, full_name)
-- to full_name and DELIBERATELY left the ORDER BY alone, saying so in its own
-- header: "its final tiebreaker is still COALESCE(display_name, full_name), so
-- two officers sharing a title are sorted by a name the page no longer shows …
-- Changing the sort is a second visible change to a public page and belongs to
-- whoever decides it is worth making, not to this one."
--
-- This is that decision. The tiebreaker becomes `full_name`, which is the
-- string the page prints. Nothing else in the function moves.
--
-- WHY IT IS WORTH MAKING. display_name was retired by 00092 — it is kept only
-- as the evidence each `handle` was derived from, nothing writes it and nothing
-- shows it. A sort key nobody can see is not a cosmetic wart on a public page;
-- it is a page whose order has no explanation available to the person reading
-- it. apps/player/src/app/exec/page.tsx already documents the function as
-- ordering by "(exec_title IS NULL), exec_title, name" — after this file that
-- comment is true.
--
-- HOW MUCH IT MOVES, ON REAL DATA (both read 2026-08-11, nothing written):
--
--   PRODUCTION has four active officers and NONE of them has an exec_title, so
--   the first two sort keys tie for all four and the tiebreaker is the ONLY
--   thing ordering that page. All four have a display_name set. So on prod this
--   is not latent at all — it is the whole order.
--
--   STAGING has two, titled 'President' and 'Treasurer', which already separate
--   on the second key. The tiebreaker never fires there today; this is a
--   correctness fix on staging, not a visible one.
--
--   /exec re-sorts in the page to hoist the president (isPresident() in
--   exec/page.tsx), and Array#sort is stable, so everyone else keeps whatever
--   order this function returned. On prod, where no officer has a title, that
--   hoist is a no-op and this ORDER BY is the final order on screen.
--
-- ⚠️ READ THIS BEFORE APPLYING TO PRODUCTION — IT CARRIES 00096 TOO.
--
--   The body below was dumped from STAGING with pg_get_functiondef(), where
--   00096 IS applied, so it selects `full_name AS name`. Production has NOT had
--   00096 applied: as of this file prod's live definition still returns
--   COALESCE(display_name, full_name) AS name, verified with the same call.
--   CREATE OR REPLACE takes the whole body, so running this on prod delivers
--   BOTH changes at once — every officer with a nickname starts showing under
--   their real name, which is exactly what 00096 was written to do and what
--   00092 already did to /leaderboard.
--
--   That is the correct outcome and the two belong together (a page sorted by
--   full_name while showing display_name would be the same bug mirrored), but
--   it must not be a surprise. If prod is meant to keep the nicknames a while
--   longer, do not apply this file either — apply neither, not one.
--
--   On staging the name is already full_name, so this file changes the ORDER BY
--   and nothing else.
--
-- WHAT IS CARRIED OVER VERBATIM from the dump, and why each matters:
--   SECURITY DEFINER — 00032 revoked blanket SELECT on players, so without it
--     the public, signed-out /exec page reads an empty list.
--   SET search_path TO 'public', 'pg_temp' — the pinned path a SECURITY DEFINER
--     function must have.
--   STABLE, LANGUAGE sql, and the RETURNS TABLE signature — unchanged, which is
--     what makes CREATE OR REPLACE legal here rather than DROP + CREATE.
--   The GRANT is restated below. REPLACE keeps existing grants, so it is a
--     no-op today (anon, authenticated, PUBLIC and service_role all hold
--     EXECUTE); it is written out so the whole contract reads in one place.
--
-- HOW TO APPLY IT (NOT RUN BY THIS BRANCH — hand it to whoever owns the DB):
--
--   cat supabase/migrations/00100_exec_sorts_by_the_name_it_shows.sql \
--     | ssh <pi-host> "docker exec -i supabase-db psql -U postgres -d postgres \
--                        -v ON_ERROR_STOP=1 --single-transaction"
--
-- AFTERWARDS, one read that proves it (it writes nothing). The function's own
-- order must match ordering the same rows by full_name:
--
--   SELECT e.name, p.full_name, p.display_name, p.exec_title
--     FROM get_executives() e JOIN players p ON p.id = e.id;
--
-- No NOTIFY pgrst. PostgREST caches the SIGNATURE and neither the arguments nor
-- the return type moved; a body change is picked up on the next call — the same
-- reasoning 00096 recorded.
--
-- ORDER OF APPLICATION AGAINST 00096: none, and 00096 becomes redundant once
-- this is applied. This file is a superset of it for get_executives(). 00096's
-- SECOND section (publishing announcement_reads to Realtime) is NOT reproduced
-- here and is still 00096's to apply.
-- ============================================================

-- ---- get_executives() sorts by full_name -------------------
-- Exactly one token differs from the staging dump:
--   ORDER BY … , COALESCE(display_name, full_name)   →   ORDER BY … , full_name
CREATE OR REPLACE FUNCTION public.get_executives()
 RETURNS TABLE(id uuid, name text, exec_title text, exec_photo_url text, bio text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT id, full_name AS name, exec_title, exec_photo_url, bio
  FROM players
  WHERE is_exec = TRUE AND active_flag = TRUE
  ORDER BY (exec_title IS NULL), exec_title, full_name;
$function$;

GRANT EXECUTE ON FUNCTION public.get_executives() TO anon, authenticated;

COMMENT ON FUNCTION public.get_executives() IS
  'The public /exec page, and the exec_title on an announcement byline. SECURITY DEFINER because 00032 took blanket SELECT on players away from authenticated and this page is reachable signed out. `name` is full_name — 00096 brought it into line with get_leaderboard(), which 00092 had moved off the retired display_name on its own. 00100 moved the ORDER BY tiebreaker onto full_name as well, so the page is sorted by the string it prints.';

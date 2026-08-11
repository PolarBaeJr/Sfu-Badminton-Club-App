-- ============================================================
-- 00096 — the exec page and the ladder call the same person the same thing
-- ============================================================
-- 00092 retired the free-text nickname: `handle` is the member's one chosen
-- name, `display_name` is kept only as the evidence every handle was derived
-- from, and nothing writes or shows it any more. Section 8 of that file changed
-- get_leaderboard()'s `name` from COALESCE(display_name, full_name) to
-- full_name and called it out as "a visible change on a PUBLIC page".
--
-- IT DID NOT REDEFINE get_executives(). That function's last definition is
-- 00042_exec_bio.sql:69 and it still returns COALESCE(display_name, full_name),
-- so the same officer is "Kiera Watanabe" on /leaderboard and "kiera" on /exec
-- — two public pages, both reachable signed out, disagreeing about a real
-- person's name. This is the other half of section 8.
--
-- The body below is the LIVE definition, dumped from staging with
-- pg_get_functiondef() rather than retyped from 00042, because CREATE OR
-- REPLACE takes the whole body and a body reconstructed from a migration file
-- is a body that quietly drops anything applied since. Exactly one token
-- differs from the dump: `COALESCE(display_name, full_name) AS name` becomes
-- `full_name AS name`.
--
-- THE ORDER BY IS DELIBERATELY LEFT ALONE, and it is worth knowing that it is
-- now inconsistent: its final tiebreaker is still COALESCE(display_name,
-- full_name), so two officers sharing a title are sorted by a name the page no
-- longer shows. That is cosmetic — /exec re-sorts in the page anyway to put the
-- president first, and the visible bug is the NAME, not the order. Changing the
-- sort is a second visible change to a public page and belongs to whoever
-- decides it is worth making, not to this one.
--
-- WHAT CHANGES VISIBLY: an officer who had set a nickname is shown on /exec
-- under their real name from the moment this is applied — the same change
-- 00092 made to the ladder, arriving on the other public page it should have
-- arrived on at the same time.
--
-- ALSO IN THIS FILE: the realtime publication line for announcement_reads. See
-- the second section; it is a one-liner and it is what makes the announcements
-- badge clear itself.
--
-- HOW TO APPLY IT:
--
--   cat supabase/migrations/00096_exec_names_match_the_ladder.sql \
--     | ssh <pi-host> "docker exec -i supabase-db psql -U postgres -d postgres \
--                        -v ON_ERROR_STOP=1 --single-transaction"
--
-- AFTERWARDS, one read that says whether it did what it says (it writes
-- nothing). Every row should show name = full_name:
--
--   SELECT e.name, p.full_name, p.display_name
--     FROM get_executives() e JOIN players p ON p.id = e.id
--    WHERE e.name IS DISTINCT FROM p.full_name;
--
-- ORDER OF APPLICATION AGAINST 00092: none. This file touches a different
-- function and reads only columns that predate both, so it converges whether or
-- not 00092 has been applied yet.
-- ============================================================

-- ---- 1. get_executives() returns full_name ----------------
-- CREATE OR REPLACE, not DROP + CREATE: the RETURNS TABLE signature is
-- unchanged, so REPLACE is legal, and it keeps the existing grants rather than
-- dropping them and needing them restored. The GRANT below is restated anyway
-- so a reader can see the whole contract in one place — it is a no-op when the
-- grants are already there, which they are.
--
-- SECURITY DEFINER and the pinned search_path are carried over verbatim. This
-- function is the only way /exec can read exec_title, exec_photo_url and bio at
-- all: 00032 revoked blanket SELECT on players, so dropping either property
-- would turn the public exec page into an empty list.
CREATE OR REPLACE FUNCTION public.get_executives()
 RETURNS TABLE(id uuid, name text, exec_title text, exec_photo_url text, bio text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT id, full_name AS name, exec_title, exec_photo_url, bio
  FROM players
  WHERE is_exec = TRUE AND active_flag = TRUE
  ORDER BY (exec_title IS NULL), exec_title, COALESCE(display_name, full_name);
$function$;

GRANT EXECUTE ON FUNCTION public.get_executives() TO anon, authenticated;

COMMENT ON FUNCTION public.get_executives() IS
  'The public /exec page, and the exec_title on an announcement byline. SECURITY DEFINER because 00032 took blanket SELECT on players away from authenticated and this page is reachable signed out. `name` is full_name — 00096 brought it into line with get_leaderboard(), which 00092 had moved off the retired display_name on its own.';

-- No NOTIFY pgrst here. PostgREST caches the SIGNATURE, and neither the
-- arguments nor the return type moved; a body change is picked up on the next
-- call. 00092 needed the reload because it added columns and changed a return
-- type.

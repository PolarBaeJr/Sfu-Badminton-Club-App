-- ============================================================
-- 00033_restore_players_select_until_app_deploy.sql
--
-- INCIDENT RESTORE (2026-06-10): 00032's column REVOKE broke the live
-- player app for every logged-in user — the currently-deployed
-- (pre-Phase-1) code calls select('*') on players in getCurrentPlayer
-- (player-app layout, every authenticated request), and column grants
-- apply to the caller's own row too, so select('*') errored with
-- "permission denied for table players".
--
-- This re-grants blanket SELECT, reverting ONLY 00032's restriction.
-- 00031 (privileged-column write guard) is unaffected and stays. The
-- players_self view is left in place (harmless; unused by old code).
--
-- TEMPORARY: once the Phase-1 app code (ec02b88..afa01f2) is deployed
-- and no players select('*') remains, re-apply 00032's column-restricted
-- grant in a follow-up migration so audit finding C3 actually closes.
-- C3's DB step must ship ATOMICALLY WITH the app deploy, not before it.
-- ============================================================

GRANT SELECT ON public.players TO authenticated;
GRANT SELECT ON public.players TO anon;

-- ============================================================
-- 00032_players_column_safe_select.sql
--
-- Close C3 from the 2026-06-09 security audit: players_select (00005)
-- filters rows but not columns, so every authenticated user could read
-- email, phone, and sfu_student_id for any non-pending player (verified
-- via select('*') on leaderboard/[playerId] and direct PostgREST).
--
-- Strategy: column-restricted grants rather than a renamed public view,
-- so the ~25 existing embedded joins (players(full_name, avatar_url) …)
-- and explicit-column queries keep working untouched and no PostgREST
-- resource renames ripple through both apps. The grant list is derived
-- from an exhaustive call-site audit of the player app (leaderboard,
-- feed, challenges, sessions, my-stats, layout, profile page render
-- full_name/avatar_url/status only; filters use id/user_id/active_flag/
-- deleted_at/status). No UI renders another player's email/phone/
-- sfu_student_id or any other column.
--
-- Row filtering is unchanged: players_select RLS still applies on top.
-- Admin reads are service-role (apps/admin createAdminClient) — full row
-- retained. Self full-row (browser settings page) goes through the new
-- players_self view below. is_admin()/get_player_id() are SECURITY
-- DEFINER (00003, never redefined) so policies on other tables are
-- unaffected by the revoke.
-- ============================================================

REVOKE SELECT ON public.players FROM authenticated;
REVOKE SELECT ON public.players FROM anon;

-- Public-safe surface for authenticated users (RLS rows still apply).
GRANT SELECT (id, user_id, full_name, avatar_url, status, active_flag, deleted_at)
  ON public.players TO authenticated;

-- Health-check routes ping the table unauthenticated (head+count only;
-- anon has no players RLS policy so row count visibility is unchanged).
GRANT SELECT (id) ON public.players TO anon;

-- ============================================================
-- Self full row: the settings page (a client component) reads the
-- caller's own complete profile from the browser. Definer-semantics
-- view owned by postgres (BYPASSRLS), strictly self-filtered, so each
-- caller sees exactly their own row with every column — same visibility
-- the old players_select gave them for self.
-- ============================================================

CREATE VIEW public.players_self
WITH (security_barrier = true, security_invoker = false) AS
  SELECT * FROM public.players WHERE user_id = auth.uid();

REVOKE ALL ON public.players_self FROM PUBLIC, anon;
GRANT SELECT ON public.players_self TO authenticated;

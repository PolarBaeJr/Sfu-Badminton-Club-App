-- ============================================================
-- 00034_reapply_players_column_grant.sql
--
-- Close audit finding C3 for real. Migration 00033 re-granted blanket
-- SELECT on players to end the 2026-06-10 outage (the then-deployed
-- pre-Phase-1 code ran select('*') on players, which a column grant
-- denies even on the caller's own row). The Phase-1 app code is now
-- deployed (commits ec02b88..afa01f2, smoke-tested 2026-06-11): no
-- players select('*') remains — self full-row reads go through the
-- players_self view or service role, and every other read is
-- explicit-column or a narrowed embed. So the column restriction is
-- safe to re-apply.
--
-- This is 00032's grant logic, re-asserted idempotently. The
-- players_self view created by 00032 survived 00033 untouched; it is
-- re-asserted here (CREATE OR REPLACE) so this migration is
-- self-contained.
-- ============================================================

REVOKE SELECT ON public.players FROM authenticated;
REVOKE SELECT ON public.players FROM anon;

-- Public-safe surface for authenticated users (RLS rows still apply).
GRANT SELECT (id, user_id, full_name, avatar_url, status, active_flag, deleted_at)
  ON public.players TO authenticated;

-- Health-check routes ping the table unauthenticated (head+count only;
-- anon has no players RLS policy so row count visibility is unchanged).
GRANT SELECT (id) ON public.players TO anon;

-- Self full row for the settings page (client component reads own
-- complete profile from the browser). Definer-semantics view owned by
-- postgres (BYPASSRLS), strictly self-filtered. Re-asserted idempotently.
CREATE OR REPLACE VIEW public.players_self
WITH (security_barrier = true, security_invoker = false) AS
  SELECT * FROM public.players WHERE user_id = auth.uid();

REVOKE ALL ON public.players_self FROM PUBLIC, anon;
GRANT SELECT ON public.players_self TO authenticated;

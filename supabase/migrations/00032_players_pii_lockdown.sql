-- ============================================================
-- 00032_players_pii_lockdown.sql — stop members reading each other's contacts
-- ============================================================
-- players_select (00005_rls.sql) lets any authenticated user read every
-- approved player's row, and RLS governs ROWS, not COLUMNS — so once a row is
-- visible, so is every field on it. A member could query the API directly and
-- pull the club's entire contact list:
--
--   Steven Sun       lsa139@sfu.ca
--   Aditya Kulkarni  adityakul0314@gmail.com
--   ...
--
-- which also contradicts the seeded privacy policy (00014), where email and
-- phone are admin-only.
--
-- Column privileges are the missing half. SELECT is revoked wholesale and
-- re-granted on the fields members legitimately need to see about each other;
-- email, phone, notification_preferences, is_banned, ban_reason, fee_exempt,
-- eligibility_flag, waiver_reset_at and deletion_requested_at are no longer
-- readable by another member.
--
-- ORDERING MATTERS. A column grant denies select('*') even on the caller's OWN
-- row, so any deployed code doing that breaks the moment this runs. The
-- upstream project hit exactly this and had to re-grant blanket SELECT to end
-- an outage (their 00033) before re-applying it (their 00034). The app changes
-- that remove every players select('*') ship BEFORE this migration:
--   * server-side reads (getCurrentPlayer, root layout, calendar feed,
--     opponent-email lookups for notifications) use the service-role client,
--     scoped by the verified session — not by anything the caller supplies;
--   * the settings page, which is a client component reading the user's own
--     full profile, goes through the players_self view below;
--   * cross-player reads name their columns explicitly.
-- ============================================================

REVOKE SELECT ON public.players FROM authenticated;
REVOKE SELECT ON public.players FROM anon;

-- What one member may see about another. Deliberately excludes contact details
-- and every moderation/billing flag. full_name is generated from first/last
-- (00023) so all three travel together.
GRANT SELECT (
  id, user_id,
  first_name, last_name, full_name, display_name,
  avatar_url, bio,
  status, active_flag, role, is_exec,
  hide_from_leaderboard, show_activity_status
) ON public.players TO authenticated;

-- Health checks ping the table unauthenticated (head + count only). anon has no
-- players RLS policy, so row visibility is unchanged by this grant.
GRANT SELECT (id) ON public.players TO anon;

-- The settings page is a client component that reads the signed-in user's own
-- complete profile — including the phone and notification preferences the grant
-- above withholds. A definer-semantics view owned by postgres, filtered to
-- auth.uid(), returns exactly one row: the caller's own.
CREATE OR REPLACE VIEW public.players_self
WITH (security_barrier = true, security_invoker = false) AS
  SELECT * FROM public.players WHERE user_id = auth.uid();

REVOKE ALL ON public.players_self FROM PUBLIC, anon;
GRANT SELECT ON public.players_self TO authenticated;

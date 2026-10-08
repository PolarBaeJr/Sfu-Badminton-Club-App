-- 00153 — no-show and absence history is not public
--
-- APPLY THIS AFTER THE APP DEPLOY, and after 00152. The order is:
--
--     00152  ->  app deploy  ->  00153
--
-- Applied before the deploy, the members' schedule loses the cross-member read
-- it still makes and every session card silently prints 0 attendees — the read
-- does not error, it just returns the viewer's own row.
--
-- WHAT WAS WRONG
--
-- `attendance_select ON session_attendance FOR SELECT TO authenticated
-- USING (TRUE)` — 00005_rls.sql:111 — with `status`, `checked_in_at`,
-- `marked_by` and `marked_at` all readable. `status` carries 'no_show' and
-- 'excused', so any signed-in member could ask
--
--   /rest/v1/session_attendance?select=player_id,session_id,status
--
-- and get the club's itemised attendance record for every member: who was
-- marked absent, on which night, and by which officer.
--
-- The database already decided this is private. `reliability_metrics` — which
-- is nothing but the AGGREGATE of these rows — is limited to your own row by
-- `rm_select_own`. The summary was locked and the itemised source it is
-- computed from was left open.
--
-- WHAT THE NEW POLICY SAYS
--
--   your own rows                      the member's own history, which they
--                                      see on /my-stats and in the feed
--   anyone with console access         admin, exec or trainer — this is the
--                                      door list, and taking attendance is the
--                                      job. admin_access_level() is the same
--                                      predicate the console's own middleware
--                                      resolves through (00054, 00087).
--
-- `attendance_admin` (FOR ALL USING is_admin) already covered role='admin', so
-- the clause that actually changes anything is exec and trainer — and it has to
-- be here, because apps/admin/src/app/sessions/live-attendance.tsx subscribes to
-- this table with the BROWSER anon client while the page renders through the
-- service role. Narrowing to own-rows-or-is_admin would have left every exec's
-- live door screen silently empty, and realtime failures in this codebase are
-- silent by construction (see that file's own header).
--
-- WHO WAS CHECKED BEFORE NARROWING THIS
--
--   player app   sessions/page.tsx ...... the ONLY cross-member read; now goes
--                                         through get_session_attendee_counts
--                                         (00152)
--                feed/page.tsx .......... .eq('player_id', player.id)
--                my-stats/page.tsx ...... .eq('player_id', player.id)
--                my-stats/past-season ... .eq('player_id', player.id)
--                actions/sessions.ts .... INSERT of the member's own row;
--                                         attendance_insert is untouched
--   admin app    sessions/page.tsx, dashboard/page.tsx — createAdminClient()
--                (service role), unaffected by RLS
--                sessions/live-attendance.tsx — browser client, covered by the
--                console clause above
--
-- INSERT AND UPDATE ARE NOT TOUCHED. `attendance_insert` (00008) still lets a
-- member check themselves in, and `attendance_admin` still lets the desk mark
-- anybody. This migration is about who may READ the result.

BEGIN;

DROP POLICY IF EXISTS attendance_select ON public.session_attendance;

CREATE POLICY attendance_select ON public.session_attendance
  FOR SELECT TO authenticated
  USING (
    player_id = get_player_id(auth.uid())
    OR admin_access_level(auth.uid()) IS NOT NULL
  );

COMMIT;

NOTIFY pgrst, 'reload schema';

-- VERIFY (as the owner, after applying):
--
--   -- as an ordinary member, this must come back with only their own rows:
--   curl -H "apikey: $ANON" -H "Authorization: Bearer $MEMBER_JWT" \
--     "$SUPABASE_URL/rest/v1/session_attendance?select=player_id,status&limit=50"
--
--   -- and the member app's schedule must still print non-zero attendee counts,
--   -- which is what proves 00152 landed first and the app is using it.
--
--   -- as an exec (not role='admin'), the console's live door screen must still
--   -- fill in.

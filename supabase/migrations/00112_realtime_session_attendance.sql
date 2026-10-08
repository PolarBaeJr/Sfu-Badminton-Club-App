-- ============================================================
-- 00112_realtime_session_attendance.sql — publish session_attendance so the
-- console's door surfaces can watch the door
-- ============================================================
-- WHY
-- ---
-- Two places in the admin app subscribe to postgres_changes on
-- session_attendance:
--
--   apps/admin/src/app/sessions/live-attendance.tsx  (the shared hook)
--     <- AttendanceDialog in apps/admin/src/app/sessions/actions.tsx
--     <- the "Just scanned in" door feed on apps/admin/src/app/sessions
--
-- An exec working the door has /sessions open on a laptop while members scan
-- themselves in from their phones. `revalidatePath('/sessions')` on the
-- mutation path covers the exec's OWN marks and nothing else, so somebody
-- else's check-in only appeared on a manual reload.
--
-- *** NOTHING HAPPENS UNTIL THIS STATEMENT IS RUN. ***
--
-- A subscription to a table that is not a member of `supabase_realtime`
-- SUCCEEDS and then never fires: .subscribe() resolves, the callback simply
-- never runs, nothing errors anywhere. That is not a hypothetical here — it is
-- what 00036 was written to fix after the leaderboard and the announcements
-- badge shipped "live" and were silently static for months. Until this file is
-- applied, both surfaces above behave exactly as they did before: correct on
-- load, correct after the viewer's own write, stale otherwise.
--
-- SAFE TO PUBLISH
-- ---------------
-- Publishing a table streams its rows to every subscribed client, filtered by
-- RLS, so the question is always "does this hand out something a query would
-- not". It does not:
--
--   * RLS is enabled on session_attendance (00005), and attendance_select is
--     `FOR SELECT TO authenticated USING (TRUE)` (00005:111). Every signed-in
--     member can already SELECT every row in this table; Realtime evaluates
--     the same policy per subscriber, so this publishes to exactly the
--     audience that could already read it.
--
--   * The row carries session_id, player_id, checked_in_at, status, marked_by
--     and marked_at — four ids and two timestamps. No NAME is in it. The door
--     list and the feed show names because the SERVER joins `players` when it
--     re-renders; the socket only ever says "session X changed", and the
--     re-render is what decides what the viewer may see. That is deliberate:
--     the console gates fee badges on `fees.clubfees.read` and the walk-in
--     roster on `sessions.attendance.write`, and a live update must not become
--     a way around either. Both callbacks call router.refresh() rather than
--     merging the payload into local state, so every gate is re-evaluated
--     server-side on the viewer's own credentials.
--
-- 00036's rule stands and this is the fourth entry against it: publish only
-- what the UI actually listens to. `players` in particular must still never be
-- added — 00032 took blanket SELECT away from `authenticated`, and publishing
-- it would hand back the columns that migration withheld.
--
-- NO COLUMN LIST, DELIBERATELY. A publication column list must contain every
-- replica-identity column, and the replica identity here is left at the
-- default — the primary key, `id`, which is not one of the six columns above.
-- `ADD TABLE … (session_id, player_id, …)` would be rejected outright. Default
-- replica identity is the right setting regardless: the callbacks only need to
-- know that something changed, not what the old row said.
--
-- IDEMPOTENT, like 00096 and unlike 00036's bare ADD. `ALTER PUBLICATION …
-- ADD TABLE` raises "relation is already member of publication" on a second
-- run, and a migration that cannot be piped in twice is a migration nobody
-- dares re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'session_attendance'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.session_attendance;
  END IF;
END
$$;

-- WORTH KNOWING BEFORE THIS IS RUN ON STAGING, and still true as of 00096:
-- staging's supabase_realtime publication is EMPTY — 00036 has never been
-- applied there — so this statement will make session_attendance the only
-- published table on that database while `ratings` and `announcements` stay
-- silent. This file does not fix that, because reapplying 00036 is 00036's
-- job:
--
--   ALTER PUBLICATION supabase_realtime ADD TABLE ratings, announcements;
--
-- Production has both, verified against pg_publication_tables.

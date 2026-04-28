-- Aggregate attendee counts per session. Replaces a client-side reduce over up
-- to 5000 attendance rows in the player app's sessions page.
-- security_invoker = true so the view honors session_attendance's RLS as the
-- calling user, not the view owner.
create or replace view public.session_attendance_counts
with (security_invoker = true) as
select
  session_id,
  count(*)::int as count
from public.session_attendance
group by session_id;

grant select on public.session_attendance_counts to anon, authenticated;

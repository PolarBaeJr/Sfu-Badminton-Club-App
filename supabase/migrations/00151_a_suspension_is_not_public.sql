-- 00151 — a suspension is not a public fact
--
-- APPLY THIS AFTER THE APP DEPLOY, NOT BEFORE.
-- The commit that must be live first is the one adding
-- apps/player/src/lib/public-profile.ts and taking
-- /leaderboard/[playerId] off the members' own key. Applied before that
-- deploy, the ladder profile's read loses a column it still names, PostgREST
-- 403s the WHOLE request, and — per the standing gotcha in this repo — the
-- failure arrives in the app as empty data, so the page 404s silently instead
-- of erroring. After the deploy, no read in either app names this column
-- through the anon key and the revoke is invisible.
--
-- WHAT WAS WRONG
--
-- `players.status` is one column carrying two unrelated vocabularies:
--
--     competitive | recreational   the member's own competitive track
--     suspended | pending_approval a decision the CLUB made about them
--
-- 00032 locked this table down and its own header says it withheld every
-- moderation flag — `is_banned`, `ban_reason` and `fee_exempt` were all
-- correctly left out of the grant. `status` was granted for the sake of its
-- first half, and the second half rode along. The ladder profile drew whatever
-- came back as a pill, so tapping a name in the feed told any signed-in member
-- that the club had suspended that person.
--
-- The list page never leaked it: get_leaderboard() has excluded
-- ('pending_approval','suspended') since 00003 and still does. It was the
-- per-member profile, and only that.
--
-- WHY THE GRANT HAS TO GO TOO
--
-- The app change alone stops the RENDER. It does not stop the READ: any member
-- with their own session token can ask PostgREST for
-- /rest/v1/players?select=full_name,status and get the club's whole suspension
-- list back as JSON. An app-layer fix to a grant-layer leak is half a fix, and
-- this file is the other half.
--
-- WHO STILL READS IT (all verified before writing this — see the source scan in
-- apps/player/src/lib/__tests__/profile-status-privacy.test.ts, which fails if a
-- new one appears):
--
--   player app   lib/public-profile.ts .......... service role, collapses it
--                lib/challengeable-opponents.ts . service role, filter only
--                lib/reactivate.ts .............. service role, own row
--                app/layout.tsx ................. service role, own row
--                app/api/calendar/[token] ....... service role
--                app/api/passkey/login/verify ... service role
--   admin app    every players read goes through createAdminClient()
--                (service role); no client component in apps/admin reads the
--                table at all.
--   view         players_self is security_invoker = false (00032, reaffirmed
--                by 00134), so it runs with the owner's privileges and keeps
--                returning the caller's own status.
--   function     get_leaderboard() is SECURITY DEFINER and returns `status`
--                for the two public values only. Unaffected, deliberately: the
--                ladder's Competitive/Recreational tabs run off it.
--
-- The service role holds its privileges independently of `authenticated`, so
-- none of the above is touched by this revoke.
--
-- WHAT THIS DOES NOT DO
--
-- `role` and `is_exec` stay granted. They are a different argument (who holds
-- office is a published fact on /exec) and changing them here would smuggle a
-- second decision into a migration about moderation. `active_flag` also stays:
-- it is not a moderation verdict, it is whether somebody is around this term.

BEGIN;

REVOKE SELECT (status) ON public.players FROM authenticated;

COMMENT ON COLUMN public.players.status IS
  'The member''s standing: ''competitive'' or ''recreational'' (their own competitive track, chosen at signup and changed by the console) or ''suspended'' / ''pending_approval'' (moderation states the club sets). NO SELECT GRANT FOR `authenticated` AND MUST NOT BE GIVEN ONE (00151): the two moderation values turn any read of this column into a published suspension list, and players_select admits any member to any approved member''s row. Read it with the service role and collapse it first — apps/player/src/lib/public-profile.ts is the reference: it returns the track to everyone and the moderation value only to the member themselves and to admins. get_leaderboard() (SECURITY DEFINER) returns it for the two public values only, which is what the ladder''s tabs filter on; players_self (definer semantics) returns the caller''s own.';

COMMIT;

-- PostgREST caches the schema, including privileges. Without this the revoke
-- takes effect in Postgres but PostgREST keeps serving from its old view of the
-- column list until the next restart.
NOTIFY pgrst, 'reload schema';

-- VERIFY (as the owner, after applying):
--
--   SELECT 1 FROM information_schema.column_privileges
--    WHERE table_name = 'players' AND column_name = 'status'
--      AND grantee = 'authenticated';
--   -- expected: 0 rows
--
-- and from a member's browser session, this must now come back 403 rather than
-- with rows:
--
--   curl -H "apikey: $ANON" -H "Authorization: Bearer $MEMBER_JWT" \
--     "$SUPABASE_URL/rest/v1/players?select=full_name,status&limit=5"
--
-- while the ladder, the ladder profile and the member's own Settings page all
-- still render.

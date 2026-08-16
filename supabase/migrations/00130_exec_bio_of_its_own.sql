-- ============================================================
-- 00130 — the exec page gets a bio of its own
-- ============================================================
-- 00042 made an exec's `players.bio` PUBLIC. It did that honestly — it added
-- the column to get_executives(), and it made the Settings screen say so ("As
-- an exec, your bio is shown publicly on the club's exec page"), because
-- "silently publishing text someone wrote under different assumptions is not
-- something a migration should do quietly".
--
-- What it could not fix is that ONE field was then doing TWO jobs. The same 500
-- characters are a member's personal bio — shown on their ladder profile at
-- /leaderboard/[playerId], to signed-in members — and, if they happen to be an
-- exec, the club's public-facing blurb about one of its officers. Those are not
-- the same piece of writing. An officer who wants "VP Finance. Ask me about
-- court bookings and reimbursements." on the club page does not want that as
-- the thing their teammates read next to their Elo, and an officer who steps
-- down should not have to remember to rewrite anything.
--
-- The club owner asked for them separated: "the exec bio in the exec page
-- should be hidden in the exec panel so we can separate the 2 bios."
--
-- AFTER THIS FILE:
--   players.bio       personal. Settings edits it; the ladder profile shows it
--                     to signed-in members. PUBLISHED NOWHERE — /exec stops
--                     reading it, and Settings' helper text stops claiming it.
--   players.exec_bio  the club's public blurb for an officer. Edited on /exec
--                     itself, by that officer, and rendered by /exec.
--
-- THE TRAINER DISTINCTION IS UNTOUCHED and this is the file that could have
-- broken it. A varsity trainer is NOT an exec (00054 — is_trainer is its own
-- column, and it opens the console without putting anyone on the exec team).
-- get_executives() still filters on `is_exec = TRUE AND active_flag = TRUE`, so
-- a trainer appears on no public page, has no exec_bio worth writing, and their
-- personal bio stays exactly as private as it is today. The backfill below is
-- keyed on is_exec for the same reason.
--
-- ------------------------------------------------------------
-- HOW TO APPLY IT (NOT RUN BY THIS BRANCH — hand it to whoever owns the DB)
-- ------------------------------------------------------------
--   cat supabase/migrations/00130_exec_bio_of_its_own.sql \
--     | ssh <pi-host> "docker exec -i supabase-db psql -U postgres -d postgres \
--                        -v ON_ERROR_STOP=1 --single-transaction"
--
-- IDEMPOTENT end to end: ADD COLUMN IF NOT EXISTS, a backfill whose WHERE
-- clause excludes every row it has already written, and CREATE OR REPLACE.
--
-- ORDER AGAINST THE APP DEPLOY, and it differs between the two halves:
--
--   READING /exec — NO ORDER AT ALL, and that is deliberate. See section 3:
--     get_executives() keeps its exact signature and keeps returning a column
--     named `bio`, so the page renders identically whether this file lands
--     before or after the deploy. A renamed output column would have made
--     EITHER ordering strand the public page with every officer's blurb
--     missing, and this is the one function `anon` can call.
--
--   WRITING a bio — THIS FILE FIRST, or with the deploy. The deploy adds the
--     editor and its server action (updateExecBio), which writes exec_bio. Ship
--     the app against a database that has not had this applied and an officer
--     sees the editor, types, presses Save and gets `column "exec_bio" does not
--     exist` as a toast. Nothing is damaged and nothing is published wrongly —
--     the write simply fails — but it is a broken control on a live page, so
--     apply this first.
--
--   The safe sequence is therefore: apply this file, then deploy. Applying it
--   early costs nothing: until the deploy the column is written by nobody and
--   read only by a function whose output is unchanged.
--
-- THE FUNCTION'S OTHER CALLER IS UNAFFECTED. getExecutives() is called twice in
-- the app — /exec, and apps/player/src/app/announcements/page.tsx:158, which
-- builds a Map of `id -> exec_title` for the byline (:163) and never touches
-- `bio`. So this change is confined to the one page, and the announcements
-- byline sees nothing.
-- ============================================================


-- ---- 1. the column ------------------------------------------
-- TEXT and nullable, exactly like `bio` (00001:173). No length CHECK, also like
-- `bio`: the 500-character cap lives in the zod schema both write paths parse,
-- and adding a constraint here that `bio` does not have would mean the two
-- fields disagree about what a bio is for no reason anybody could name.
ALTER TABLE players ADD COLUMN IF NOT EXISTS exec_bio TEXT;

COMMENT ON COLUMN players.exec_bio IS
  'The blurb shown under an officer on the public /exec page. Deliberately separate from players.bio, which is the member''s personal bio and is now published nowhere: an officer''s public description of their portfolio and their personal profile text are different pieces of writing, and stepping down from exec should not leave either one in the wrong place. Read only through get_executives() (SECURITY DEFINER); no SELECT grant to `authenticated` — see 00130 section 4.';


-- ---- 2. what happens to the bios that already exist ---------
-- COPIED FORWARD, NOT LEFT BEHIND. Every exec who has written a bio wrote it
-- knowing it was the exec page text — that is precisely what 00042 put on the
-- Settings screen and what has been there ever since. Leaving it behind would
-- blank the club's public page for every officer at the moment this is applied,
-- and it would do it by silently reinterpreting words they wrote for a purpose
-- they were told about.
--
-- COPY, NOT MOVE. `players.bio` is NOT cleared afterwards, and the reason is a
-- second reader: apps/player/src/app/leaderboard/[playerId]/page.tsx:23 selects
-- `bio` straight off `players` and renders it on the member's ladder profile.
-- Clearing it would delete an exec's profile text from a screen this change is
-- not about, in the name of tidying a column. After this file an exec has the
-- same words in two places and may edit either independently — which is the
-- separation the owner asked for, arrived at without destroying anything.
--
-- THE WHERE CLAUSE IS THE IDEMPOTENCE. `exec_bio IS NULL` means a second run
-- cannot clobber an exec_bio written since the first — including one written
-- deliberately as the empty string, which is an officer clearing their public
-- blurb and must not be re-filled from their personal bio. `bio IS NOT NULL`
-- keeps it from writing NULL over NULL for no reason. `is_exec` scopes it to
-- the people whose bio was actually public: a trainer's, and an ordinary
-- member's, was never on that page and is not copied anywhere.
--
-- NOT scoped by active_flag, though get_executives() is. A deactivated officer
-- is off the page today and back on it the moment they are reactivated, and the
-- point of this backfill is that nobody's blurb disappears when it is.
UPDATE players
   SET exec_bio = bio
 WHERE is_exec = TRUE
   AND exec_bio IS NULL
   AND bio IS NOT NULL;

-- AND WHAT HAPPENS TO IT AT THE END OF AN ACCOUNT. Both purge edge functions
-- (supabase/functions/purge-deleted-accounts and purge-inactive-accounts) null
-- `bio` by name when they anonymise a row, and the branch that carries this
-- file adds `exec_bio` beside it in both. That is not optional tidying: the
-- deletion email promises "profile photo and bio are erased for good"
-- (shared/src/email/templates.ts:211) and the inactivity notice repeats it
-- (admin/src/lib/platform-setting-fields.ts:336). Splitting one bio into two
-- without splitting the erasure would have quietly narrowed a promise the club
-- has already made in writing. `active_flag = false` would have taken the row
-- off /exec anyway — but "off the page" is not what was promised.


-- ---- 3. get_executives() reads the new column ---------------
-- THE BODY BELOW IS THE LIVE PRODUCTION DEFINITION, dumped 2026-08-15 with
--
--   SELECT pg_get_functiondef(p.oid) FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'get_executives';
--
-- rather than retyped from 00100, for the reason 00096 recorded: CREATE OR
-- REPLACE takes the WHOLE body, and a body reconstructed from a migration file
-- is a body that quietly drops anything applied since. (The dump agreed with
-- 00100 exactly this time. That is a fact, not an assumption to reuse.)
--
-- EXACTLY ONE TOKEN DIFFERS from the dump:
--   SELECT … exec_photo_url, bio        →   SELECT … exec_photo_url, exec_bio AS bio
--
-- WHY `exec_bio AS bio` AND NOT A RENAMED RETURN COLUMN. Naming the output
-- `exec_bio` would change the RETURNS TABLE signature, which means DROP +
-- CREATE (CREATE OR REPLACE cannot rename an output column), which means the
-- grants below stop being a restatement and become load-bearing, plus a
-- NOTIFY pgrst — PostgREST caches the signature, which is exactly why 00096 and
-- 00100 were both able to skip the reload.
--
-- The deciding argument is not tidiness, it is that THE MIGRATION AND THE APP
-- DEPLOY ARE SEPARATE EVENTS on a live app. With a renamed column, either order
-- strands the public page: migration first and the deployed page reads `bio`
-- off a row that no longer has it; deploy first and the new page reads
-- `exec_bio` off a function that does not return it yet. Both render /exec with
-- every officer's blurb missing, and there is no ordering that avoids it. With
-- the alias there is no window at all — the function keeps returning `bio`, the
-- backfill above means the same text comes back, and the page is byte-identical
-- the instant this is applied.
--
-- The alias is a slight lie about provenance, and this function already tells
-- the same kind: `full_name AS name` has been in it since 00096. It is paid for
-- where this repo always pays for it — the COMMENT below, this header, and the
-- return type in apps/player/src/lib/supabase-server.ts, which all say which
-- column the value comes from.
--
-- CARRIED OVER VERBATIM, and each matters:
--   SECURITY DEFINER — 00032 revoked blanket SELECT on players. Without it the
--     signed-out /exec page reads an empty list. It is ALSO what makes section
--     4's "no SELECT grant" decision work: a definer function runs as its owner
--     and never consults the caller's column grants.
--   SET search_path TO 'public', 'pg_temp' — the pinned path a SECURITY DEFINER
--     function must have.
--   STABLE, LANGUAGE sql, the RETURNS TABLE signature, and the ORDER BY 00100
--     settled — all unchanged, which is what keeps CREATE OR REPLACE legal.
--   The GRANT is restated so the whole contract reads in one place. REPLACE
--     keeps existing grants, so it is a no-op today.
CREATE OR REPLACE FUNCTION public.get_executives()
 RETURNS TABLE(id uuid, name text, exec_title text, exec_photo_url text, bio text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT id, full_name AS name, exec_title, exec_photo_url, exec_bio AS bio
  FROM players
  WHERE is_exec = TRUE AND active_flag = TRUE
  ORDER BY (exec_title IS NULL), exec_title, full_name;
$function$;

GRANT EXECUTE ON FUNCTION public.get_executives() TO anon, authenticated;

COMMENT ON FUNCTION public.get_executives() IS
  'The public /exec page, and the exec_title on an announcement byline. SECURITY DEFINER because 00032 took blanket SELECT on players away from authenticated and this page is reachable signed out. `name` is full_name — 00096 brought it into line with get_leaderboard(), which 00092 had moved off the retired display_name on its own. 00100 moved the ORDER BY tiebreaker onto full_name as well, so the page is sorted by the string it prints. 00130: the output column `bio` is now sourced from players.EXEC_BIO, not players.bio — the personal bio and the club''s public blurb about an officer were split into two fields. The output name was kept so the change needed no coordination with the app deploy.';

-- No NOTIFY pgrst, for the reason 00096 and 00100 both give: PostgREST caches
-- the SIGNATURE, and neither the arguments nor the return type moved. A body
-- change is picked up on the next call.


-- ---- 4. the things this file deliberately does NOT do -------
--
-- (a) NO `GRANT SELECT (exec_bio) ON players TO authenticated`.
--
--     `players` is column-granted, not blanket (00032), and a missing grant
--     fails the WHOLE PostgREST request with 403 that arrives as empty data —
--     so the question has to be answered on purpose rather than by habit.
--
--     THE ANSWER IS NO, because nothing reads this column off the table.
--     Contrast `bio`, which IS granted to authenticated and needs to be:
--     leaderboard/[playerId]/page.tsx:23 does `.from('players').select('…,
--     bio')` with the member's own JWT. exec_bio has exactly one reader,
--     get_executives(), which is SECURITY DEFINER and therefore runs as its
--     owner — column grants to `authenticated` are not consulted at all. The
--     exec panel's editor is fed from that same function; it does not go to the
--     table for it.
--
--     Granting it anyway would not be neutral. players_select admits any
--     approved member to any other approved member's ROW (the reasoning 00111
--     spells out for competition_category), so a column grant on `players` is
--     the difference between "the exec team's blurbs" and "every member's
--     exec_bio, including drafts written by people who are not on the page".
--
--     The WRITE side needs no grant either. UPDATE on `players` is table-wide
--     for `authenticated` already (verified live, and 00128 deliberately did
--     not touch `authenticated`), and in any case the only writer is a server
--     action using the service-role client (see (b)).
--
--     AND NOTHING IS GRANTED TO `anon`, WHICH 00128 WOULD NOT FORGIVE. That
--     file took every table privilege on `players` away from PUBLIC and anon —
--     including the lone `SELECT (id)` — and ends with an assertion that aborts
--     if ANY column ACL on `players` still names anon. `ALTER TABLE … ADD
--     COLUMN` creates no ACL entry of its own (a column is only in pg_attribute
--     .attacl once something is granted on it), so exec_bio lands with an empty
--     ACL and that assertion stays true whichever order the two files are
--     applied in. This is also why the SECURITY DEFINER property in section 3
--     is now doing MORE work than 00042 needed it to: after 00128 the anon key
--     cannot read a single column of `players`, so the function is not merely
--     the easiest way for /exec to read an officer's blurb signed out — it is
--     the only one. 00126 keeps get_executives() among the three RPCs anon may
--     still EXECUTE, alongside get_leaderboard() and get_active_season(), and
--     asserts that grant survives; the restated GRANT above is that same grant,
--     not a widening of it.
--
-- (b) guard_player_privileged_columns() IS NOT REDEFINED.
--
--     exec_photo_url joined that trigger in 00042, and the symmetry is
--     tempting: exec_bio publishes to the same page. It is deliberately left
--     alone, on two grounds.
--
--     It would buy nothing on the path that matters. The legitimate writer is
--     apps/player/src/lib/actions/exec.ts updateExecBio, which resolves the
--     caller from their verified session, refuses anyone who is not an active
--     exec, and writes with the SERVICE-ROLE client. The trigger opens with
--     `IF auth.uid() IS NULL OR is_admin(auth.uid()) THEN RETURN NEW` — a
--     service-role write has no auth.uid() and is waved straight through. This
--     is the same thing apps/admin/src/lib/player-field-access.ts documents at
--     length: that trigger protects a member editing their own row with their
--     own JWT and does nothing for a server action.
--
--     What it would buy is stopping a non-exec setting their OWN exec_bio
--     through raw PostgREST — text that is inert unless and until an admin
--     makes them an exec, which is a deliberate act that also sets exec_title
--     and exec_photo_url and is done looking at the person. That is exactly the
--     exposure `players.bio` has had since 00001 and is not what this file is
--     for.
--
--     Against that: the trigger is CREATE OR REPLACEd WHOLESALE, and 00042's
--     own header is a warning about what that costs — 00040's membership_type
--     protection survived only because the two files happened to meet. Every
--     column added to it since would have to be dumped live and carried
--     forward correctly, and getting that wrong is a silent security regression
--     on a live app. A redefinition that buys nothing on the real write path is
--     not worth that risk. If exec_bio should ever join it, dump the live
--     definition first — do not build it from 00042.
--
-- (c) `players_self` IS NOT RE-CREATED, and exec_bio will not appear in it.
--
--     Postgres expands `SELECT *` when a view is created and freezes the column
--     list, so that view still returns the columns `players` had in 00032. That
--     is correct here and nothing should try to fix it: the Settings screen
--     reads players_self and Settings has no business reading the exec bio.
--     00060 also excluded a column from it on purpose, which re-creating would
--     undo.
--
-- (d) NOTHING IS ADDED TO `supabase_realtime`. `players` is the one table 00036
--     named as never publishable, and logical replication consults neither
--     grants nor RLS (00114). exec_bio is on `players`, so it inherits that
--     protection by doing nothing.


-- ============================================================
-- AFTERWARDS — reads that say whether it did what it says.
-- All three write nothing.
-- ============================================================
--
-- 1. Every active officer's public blurb survived the split, and /exec renders
--    the same text it rendered before. Expect ZERO rows:
--
--      SELECT p.full_name, p.bio, p.exec_bio
--        FROM players p
--       WHERE p.is_exec AND p.active_flag
--         AND COALESCE(p.exec_bio, '') IS DISTINCT FROM COALESCE(p.bio, '');
--
--    (Rows here are only expected on a LATER run, once officers have started
--    editing the two independently. On the first run, zero.)
--
-- 2. The function returns the new column under the old name, and `anon` — the
--    signed-out visitor — can still call it:
--
--      SET ROLE anon;
--      SELECT id, name, exec_title, bio FROM get_executives();
--      RESET ROLE;
--
-- 3. Nobody but the definer function can read the column. Expect a permission
--    error, NOT rows:
--
--      SET ROLE authenticated;
--      SELECT exec_bio FROM players LIMIT 1;   -- ERROR: permission denied
--      RESET ROLE;
-- ============================================================

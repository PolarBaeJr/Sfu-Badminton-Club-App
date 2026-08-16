-- ============================================================
-- 00129_gender_is_set_once.sql — the field 00111 added, relabelled
-- "Gender", and locked after the member's first answer
-- ============================================================
-- READ 00111 FIRST. Everything below sits on top of it and none of it is
-- independently defensible; this file changes two things about that column and
-- deliberately leaves the rest of it exactly as written.
--
-- THE OWNER'S TWO SENTENCES, which are the whole brief:
--
--   1. The Settings control now says "Gender" rather than "Tournament events".
--   2. Once a member has set it, only an exec can change it. A member who has
--      never set it can still choose.
--
-- (1) IS A LABEL AND CHANGES NO DATA. The column keeps its name, its type, its
-- CHECK and its two values. What moved is the word above the dropdown in the
-- player app and the words inside it ('Man' / 'Woman' rather than "Men's
-- events" / "Women's events" — "Gender: Men's events" is not a sentence). The
-- stored values still name DRAWS, which is why they are still 'mens' and
-- 'womens' and not something that reads as an identity.
--
-- (2) IS THIS MIGRATION. A member holds `UPDATE (competition_category)` on
-- `players` — 00111 granted it, on purpose, and it is still the right grant —
-- so hiding the dropdown once a value is set changes nothing at all: the
-- browser holds a working anon key, players_update_own admits the member to
-- their own row, and one PATCH past the UI rewrites the value. The lock has to
-- be in the database or it is not a lock. This file is that trigger.
--
-- ------------------------------------------------------------
-- WHY A SECOND TRIGGER RATHER THAN A LINE IN THE EXISTING ONE
-- ------------------------------------------------------------
-- guard_player_privileged_columns (00092, latest definition) is already a
-- BEFORE INSERT OR UPDATE trigger on this table over a list of columns a member
-- may not write, and adding one more name to that list is the obvious move. It
-- is wrong here, for a reason that is written down in the app already
-- (apps/admin/src/lib/player-field-access.ts:7-13, verified against the live
-- definition on 2026-08-05): that function opens with
--
--     IF auth.uid() IS NULL OR is_admin(auth.uid()) THEN RETURN NEW;
--
-- and EVERY console write goes through the service-role key, where auth.uid()
-- is NULL. The guard is a member-with-their-own-JWT guard and nothing else.
-- Its opening is fine for what it protects — the console is checked in app
-- code before it gets there — but inheriting it here would mean the console
-- bypass IS the gender bypass, and worse, `auth.uid() IS NULL` is ALSO true for
-- `anon`. That is the exact trap 00126:37-39 documents on apply_match_result:
-- a guard written as `IF auth.uid() IS NOT NULL AND NOT is_admin(...)` skipped
-- every branch for an anonymous caller. Copying that shape is the one mistake
-- this file cannot make.
--
-- Two BEFORE UPDATE triggers on one table is fine. Both are pass-or-RAISE and
-- neither reads what the other decides, so the alphabetical firing order
-- (guard_competition_category_lock_trg before
-- guard_player_privileged_columns_trg) has no effect on the outcome.
--
-- ------------------------------------------------------------
-- HOW THE TRIGGER TELLS AN EXEC EDIT FROM A MEMBER EDIT
-- ------------------------------------------------------------
-- BY current_user, NOT BY auth.uid(). PostgREST switches the Postgres role on
-- every request from the key's JWT — 00128 measured the call itself, 89822
-- `set_config(...)` statements attributed to `anon` in eighteen days — so
-- inside a SECURITY INVOKER trigger current_user is literally `anon`,
-- `authenticated` or `service_role`, whichever key made the request. That is
-- the same fact the GRANTs and the RLS policies are keyed to, it is set by the
-- server from a verified token, and no request body can influence it.
--
-- THE FUNCTION IS THEREFORE **SECURITY INVOKER**, AND THAT IS LOAD-BEARING.
-- Written SECURITY DEFINER — which is the house shape for trigger functions
-- here, and what a reader will assume — current_user would report the OWNER
-- (postgres) for every caller and the lock would be open to everybody. Verified
-- in a throwaway PostgreSQL 17 container before this file was finalised: under
-- SECURITY INVOKER, `SET ROLE authenticated` yields current_user =
-- 'authenticated' inside the trigger; under SECURITY DEFINER the same statement
-- yields 'postgres'. `current_setting('role', true)` is the alternative that
-- survives SECURITY DEFINER, and it is not used here because it is a GUC that
-- happens to track the role rather than the role itself.
--
-- THREE WAYS TO BE PRIVILEGED, and each is a real caller:
--
--   current_user = 'service_role'
--       The console. Every admin-app write goes through createAdminClient(),
--       and the change this migration is paired with routes it through
--       updatePlayer(), which requires players.update.write and writes an
--       audit row with a reason. RLS does not apply to that key and never did;
--       a TRIGGER does, which is why this branch has to be explicit rather
--       than assumed.
--
--   current_user NOT IN ('anon', 'authenticated')
--       A database-level caller: this migration, a later one, psql, pg_cron,
--       a SECURITY DEFINER function running as its owner (merge_players
--       reassigns rows between players and must not be refused by this).
--       Written as a NOT-IN over the two browser roles rather than an IN over
--       ('postgres','supabase_admin', ...) so that a role nobody has thought
--       of yet is not silently refused — the browser keys are the closed set
--       here, and they are the only thing this trigger is defending against.
--
--   is_admin(auth.uid())
--       An admin editing their OWN row from the player app, on the browser
--       key. Rare, and kept for the same reason 00092's guard keeps it: an
--       admin is not meant to be locked out of their own record by a rule
--       about members. auth.uid() is checked IS NOT NULL first so that this
--       branch can never be the one that decides an anonymous request —
--       is_admin(NULL) is already false, and the explicit test says so to the
--       reader rather than relying on it.
--
-- ------------------------------------------------------------
-- WHAT COUNTS AS A CHANGE
-- ------------------------------------------------------------
-- IS NOT DISTINCT FROM, so 'mens' → 'mens' and NULL → NULL are not changes and
-- are not refused. This is not a nicety: the Settings form saves the whole
-- profile in one UPDATE and re-sends every field, so an unrelated edit to a bio
-- or a phone number arrives with competition_category set to the value already
-- in the row. Comparing with `<>` would refuse every profile save a member with
-- a declared category ever makes.
--
-- NULL → 'mens' IS ALLOWED FOR A MEMBER. That is the "set it once" case and the
-- whole reason the field is still on the Settings page.
--
-- ------------------------------------------------------------
-- 'mens' → NULL IS ALSO LOCKED. THE RULING, AND WHY
-- ------------------------------------------------------------
-- The owner leaned this way and the lean is right, for a reason that is not
-- about how much a retraction is worth: IF CLEARING WERE ALLOWED, THE LOCK
-- WOULD NOT EXIST. A member who wanted to change 'mens' to 'womens' would
-- clear it (allowed), then set it (allowed, because OLD is now NULL), and land
-- exactly where a direct change would have put them, in two requests instead of
-- one. A rule with a two-step bypass is a UI convention, not an invariant, and
-- this whole file exists because a UI convention was not enough.
--
-- The cost is real and is worth naming: "prefer not to say" stops being
-- something a member can return to on their own. 00111 records NULL as meaning
-- both "not asked yet" and "prefer not to say", and after this a member who has
-- answered cannot go back to either without an exec. That is what "set once"
-- MEANS, it is what the owner asked for, and the remedy is a person rather than
-- a form — which is the same remedy the club already uses for a member code, a
-- status or a ban.
--
-- The trigger does not need a special case for it. `IS DISTINCT FROM` plus
-- "OLD IS NULL is the only unprivileged change" gives exactly this rule, and
-- gives it in two lines rather than four.
--
-- ------------------------------------------------------------
-- INSERT IS NOT GUARDED, DELIBERATELY
-- ------------------------------------------------------------
-- BEFORE UPDATE only. An INSERT that carries a value is a first declaration —
-- the same act NULL → value is on the UPDATE side — and there is nothing to
-- lock against, because there is no OLD row. In practice nothing inserts one
-- anyway: create_player_with_rating (00003) does not name the column and
-- players_self_insert bounds what a member may create.
--
-- ------------------------------------------------------------
-- THE NON-BINARY QUESTION, WEAKENED BUT NOT REOPENED
-- ------------------------------------------------------------
-- Recorded here because relabelling the field is exactly what puts pressure on
-- it. 00111's case for two values was about DRAWS: "a third value would be a
-- category with no event in it", and a member who does not want to be sorted
-- plays the Open events and is never asked again. Calling the control "Gender"
-- makes the two-value enum look like a claim about people rather than about
-- draws, which is a weaker position than 00111 held.
--
-- NOTHING IS CHANGED ON THAT BASIS, and the enum is untouched: the club still
-- runs exactly two gendered draws, the stored values still name them, the Open
-- events are still open to everybody, and NULL is still a full answer for a
-- member who has never set it. If the club ever runs a third draw, the CHECK is
-- one line and this paragraph is the note explaining why it was not written
-- pre-emptively. Recording the weakening is the deliverable; acting on it is
-- not this migration's call to make.
--
-- ------------------------------------------------------------
-- NO GRANT CHANGES. NONE. THIS IS THE PART TO NOT GET WRONG
-- ------------------------------------------------------------
-- 00111 grants `authenticated` UPDATE on this column and NOT SELECT, and the
-- reasoning behind that absence is the longest section of that file: the
-- players_select policy admits any signed-in member to any approved member's
-- ROW, so the per-column grants are the only thing between a private field and
-- the whole club. A `GRANT SELECT (competition_category) TO authenticated` here
-- would publish every member's answer to every other member. THIS FILE GRANTS
-- AND REVOKES NOTHING.
--
-- The two readers that now exist both already work without one:
--
--   * the member's own value — getMyCompetitionCategory(), a server action
--     that reads it with the service-role key filtered to the caller. The
--     player app needs it for the lock as well as for the control, and the
--     lock needs no new information: a locked field is exactly a non-NULL one,
--     so the value it already returns IS the answer.
--
--   * the console's exec control — apps/admin/src/app/players/[id]/page.tsx
--     fetches the member row with createAdminClient().select('*'), which is
--     the service-role key. The column is ALREADY in that row and already in
--     the prop the edit form receives. Checked before anything was written,
--     because a missing column grant fails the WHOLE PostgREST request with
--     403, supabase-js resolves rather than rejects, and `?? []` renders it as
--     an empty screen — four bugs in this repository have had that shape.
--
-- ------------------------------------------------------------
-- WHAT CHANGES ABOVE THE DATABASE (for the reader of this file alone)
-- ------------------------------------------------------------
-- 00111 said, in this column's own COMMENT, that the console cannot set the
-- value and that adminPlayerUpdateSchema's refusal of the key is what holds it.
-- THE OWNER HAS REVERSED THAT PREMISE, so both change together and the COMMENT
-- is rewritten at the foot of this file:
--
--   * adminPlayerUpdateSchema now accepts `competition_category`, and the test
--     that pinned its absence is inverted rather than deleted — it now pins
--     that the schema accepts it and that this trigger is what bounds who may
--     use it.
--   * The exec control lives in the member Edit dialog and saves through
--     updatePlayer(), gated on players.update.write — "Edit a member", which
--     every exec baseline already holds and which is the capability the rest of
--     that dialog is behind. NO CAPABILITY IS MINTED: a new one would mean
--     rewriting players_permission_vocabulary_check and
--     permission_baselines_vocabulary_check in full (see 00098), and none of
--     that is needed for a field that is one more line on a form an exec is
--     already authorised to save. players.privilegedfields.write was the other
--     candidate and is wrong: it sits in no baseline, so it is admin-only
--     today, and the owner asked for an EXEC.
--   * updatePlayer() already requires a `reason` and already writes a
--     logAdminAudit row carrying the whole previous row, so every exec change
--     to this field is audited with a reason for free.
--   * The field is on NEITHER PLAYER_FIELD_FLOOR NOR PLAYER_FIELD_PRIVILEGED
--     in apps/admin/src/lib/player-field-access.ts, and that is a decision
--     rather than an omission: a field on neither list passes that guard
--     freely, which is precisely "any holder of players.update.write may set
--     it".
--
-- The privacy consequence is real and is the price of the feature: an exec who
-- can edit a member can now SEE that member's answer, where 00111 was written
-- so that no console screen rendered it. It cannot be otherwise — "an exec can
-- change it" requires an exec to be shown what they are changing — and it is
-- bounded to the one dialog, behind one capability, with an audit row per edit.

BEGIN;

-- ------------------------------------------------------------
-- The lock
-- ------------------------------------------------------------
-- SECURITY INVOKER (the default, stated by omission of SECURITY DEFINER and by
-- this comment) — see the header. If a later migration adds SECURITY DEFINER to
-- this function, the lock silently opens for every caller.
--
-- search_path is pinned anyway: the function resolves is_admin and auth.uid()
-- by name, and an unqualified search_path in a trigger is how a shadowed
-- function gets called.
CREATE OR REPLACE FUNCTION public.guard_competition_category_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Not a change. Covers the profile save that re-sends the same value, and
  -- NULL → NULL. Must come first, or an ordinary "save my bio" is a refusal.
  IF NEW.competition_category IS NOT DISTINCT FROM OLD.competition_category THEN
    RETURN NEW;
  END IF;

  -- The first declaration, which is the one edit this field exists for.
  IF OLD.competition_category IS NULL THEN
    RETURN NEW;
  END IF;

  -- From here it is a change to an answer that has already been given.
  IF current_user = 'service_role'                        -- the console
     OR current_user NOT IN ('anon', 'authenticated')     -- not a browser key
     OR (auth.uid() IS NOT NULL AND public.is_admin(auth.uid()))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Gender is set once. Ask an exec to change it.'
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

COMMENT ON FUNCTION public.guard_competition_category_lock() IS
  'Makes players.competition_category write-once for a member: NULL to a value is theirs to make, every later change (including back to NULL) needs the console. SECURITY INVOKER ON PURPOSE — it tells an exec edit from a member edit by current_user, which PostgREST sets per request from the verified key, and a SECURITY DEFINER rewrite would report the owner for every caller and open the lock to everybody. Deliberately NOT folded into guard_player_privileged_columns, whose `auth.uid() IS NULL` opening waves through the service-role console AND anon alike. See 00129.';

DROP TRIGGER IF EXISTS guard_competition_category_lock_trg ON public.players;
CREATE TRIGGER guard_competition_category_lock_trg
  BEFORE UPDATE ON public.players
  FOR EACH ROW
  -- Statement-level WHEN, so the function is not even entered for the
  -- overwhelming majority of player updates (attendance stamps, ratings,
  -- status changes) that do not touch this column. The IS DISTINCT FROM inside
  -- the body is kept as well: the WHEN clause is an optimisation and the body
  -- has to be correct on its own if somebody re-creates the trigger without it.
  WHEN (NEW.competition_category IS DISTINCT FROM OLD.competition_category)
  EXECUTE FUNCTION public.guard_competition_category_lock();

-- ------------------------------------------------------------
-- The column comment, rewritten
-- ------------------------------------------------------------
-- 00111's version said the console cannot set this and that
-- adminPlayerUpdateSchema's refusal of the key is what holds it. Both halves
-- are now false, and a comment that contradicts the code is worse than none.
-- Everything else 00111 wrote here is carried across unchanged — especially the
-- SELECT-grant paragraph, which is the load-bearing one and has not moved.
COMMENT ON COLUMN public.players.competition_category IS
  'Which tournament draw this member competes in: ''mens'', ''womens'', or NULL for undeclared (which also covers "prefer not to say" — nothing distinguishes them, so nothing stores the difference). Labelled "Gender" in the player app since 00129; the stored values still name DRAWS, which is why they are these two and not an identity vocabulary. WRITE-ONCE FOR THE MEMBER (00129): they set it from NULL themselves through the player app''s updateProfile, and from then on only the console may change it — including back to NULL, because a permitted retraction would make the lock a two-step formality. Enforced by the guard_competition_category_lock_trg BEFORE UPDATE trigger, NOT by the form: `authenticated` holds UPDATE on this column, so hiding the control changes nothing. The console path is updatePlayer() in the admin app, gated on players.update.write and audited with a reason via logAdminAudit; adminPlayerUpdateSchema accepts the key as of 00129 (00111 said it must not — that premise was reversed by the club owner). `authenticated` HAS NO SELECT GRANT ON THIS COLUMN AND MUST NOT BE GIVEN ONE: players_select admits any member to any approved member''s row, so a SELECT grant would publish every member''s value to the whole club. The member reads their own through the getMyCompetitionCategory server action (service role, filtered to the caller); the console and the entry actions read it with the service-role key. NOT a gender identity or sex field for any purpose other than the label, and shown on exactly two screens: the member''s own Settings, and the member Edit dialog in the console. The entry rules built on it live in packages/shared/src/utils/competition-category.ts and are applied in all five entry paths (player self-entry, admin add-one, add-many, add-pair, swap-pair-member) plus auto pair. Open events (open_singles, open_doubles) ignore it entirely.';

-- ------------------------------------------------------------
-- Assertions. Idempotent re-run safe; every one of them is a fact this
-- migration is responsible for and a later migration could undo by accident.
-- ------------------------------------------------------------
DO $$
BEGIN
  -- The trigger exists, on the right table, at the right time.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'players'
      AND t.tgname = 'guard_competition_category_lock_trg'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION '00129: the lock trigger is not on public.players';
  END IF;

  -- SECURITY INVOKER. The single most reversible mistake in this file: a later
  -- CREATE OR REPLACE that adds SECURITY DEFINER opens the lock for everybody
  -- and nothing else would show it.
  IF (SELECT prosecdef FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'guard_competition_category_lock') THEN
    RAISE EXCEPTION
      '00129: guard_competition_category_lock is SECURITY DEFINER; it reads current_user and must be SECURITY INVOKER';
  END IF;

  -- 00111's absence, re-asserted. This migration must not have added a SELECT
  -- grant, and neither must the next one.
  IF has_column_privilege('authenticated', 'public.players', 'competition_category', 'SELECT') THEN
    RAISE EXCEPTION
      '00129: authenticated has SELECT on players.competition_category — see 00111, that grant publishes every member''s value to the club';
  END IF;

  -- ...and must not have taken the member's own write away either. Without
  -- this grant the lock guards a column nobody can set in the first place.
  IF NOT has_column_privilege('authenticated', 'public.players', 'competition_category', 'UPDATE') THEN
    RAISE EXCEPTION
      '00129: authenticated lost UPDATE on players.competition_category — the member can no longer declare one';
  END IF;
END $$;

COMMIT;

-- ============================================================
-- FOUND, NOT FIXED
-- ============================================================
-- 1. guard_player_privileged_columns STILL OPENS WITH `auth.uid() IS NULL`,
--    which is true for `anon` as well as for the service-role console. It is
--    not exploitable today — 00128 took every table grant away from anon, so
--    anon cannot reach an UPDATE on players at all — but the guard's own
--    comment says "covers the service-role console" and that is only half of
--    what the condition actually admits. Not touched here: that function is
--    replaced wholesale on every edit (00092's header is emphatic about it),
--    and re-deriving its whole body to tighten one line is a much bigger and
--    much riskier change than this migration.
--
-- 2. THE OTHER SIDE OF SECURITY INVOKER, and the thing a future RPC author has
--    to know. Because the trigger reads current_user, ANY postgres-owned
--    SECURITY DEFINER function that `authenticated` may EXECUTE can write this
--    column past the lock: inside such a function current_user is the owner,
--    which this file's third branch admits. That is correct for the functions
--    that exist — merge_players moves rows between members and must not be
--    refused — and it is clean today: checked against 00126's list of routines
--    `authenticated` still holds EXECUTE on, and not one of them writes
--    players.competition_category. It is a standing condition rather than a
--    bug, and the remedy if it is ever violated is in the new function, not
--    here: a SECURITY DEFINER routine that writes this column has to make the
--    authorization decision itself, exactly as updatePlayer does.
--
-- 3. NOTHING BACKFILLS AND NOTHING MIGRATES. Every member who has already
--    declared a category is locked as of the moment this applies, with no
--    grace period and no notice. That is the intended behaviour and the club
--    is small enough that the remedy (ask an exec) is a real one, but it is
--    worth knowing before it is applied rather than after.
--
-- 4. THE REFUSAL IS THE ONLY THING A HAND-ROLLED CLIENT GETS. The player app
--    says "once you set it, an exec changes it rather than you" beside the
--    dropdown and again on the locked state, so a member using the app is told
--    twice. Anything talking to PostgREST directly learns the rule by being
--    refused, in one sentence, with no way to ask "am I locked" first. That is
--    acceptable for a private club app and it is worth knowing that it is the
--    shape: this column has no SELECT grant, so there is no query a member's
--    own key can run to find out.

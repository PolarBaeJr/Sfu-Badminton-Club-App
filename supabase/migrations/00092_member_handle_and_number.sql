-- ============================================================
-- 00092 — one chosen name per member, and a number the club assigns
--
-- Two identifiers, and they are two different kinds of thing:
--
--   handle         the member's ONE chosen name. Unique, written `@kiera`,
--                  and the thing you search by. It REPLACES the free-text
--                  "display name / nickname" the app has been showing.
--   member_code    assigned by the club, permanent, never reused, never typed
--                  by anyone. 7 characters — K3F9TQ2 — derived from the row's
--                  own id so it is stable, and deliberately NOT sequential.
--                  Backfilled below, and stamped on everyone after that by
--                  assign_member_code().
--
-- member_code is NOT a university student number and must never become one. No
-- SFU record is stored anywhere near this column.
--
-- *** APPLY THIS BEFORE DEPLOYING THE CODE THAT GOES WITH IT. *** Saving a
-- handle from /settings writes a column that does not exist yet, approving a
-- member calls an RPC that does not exist yet, and the leaderboard reads a
-- column get_leaderboard() does not return yet.
--
-- players.display_name IS DELIBERATELY KEPT, and kept populated. Nothing writes
-- to it any more and nothing displays it, but it is what every handle below was
-- DERIVED from — and a derivation over free text is a judgement call, not a
-- rename. If the club decides somebody's handle came out wrong, the original is
-- still sitting there to work from. Dropping a column on a live database to
-- save a few bytes is a bad trade.
--
-- CORRECTED IN PLACE TWICE, AFTER TWO STAGING RUNS. Editing an applied
-- migration is normally the wrong thing to do; it is right here for one reason
-- that holds for both corrections — PRODUCTION HAS NEVER SEEN THIS FILE, so
-- there is no applied history to preserve and nothing to diverge from, and
-- shipping something known to be wrong plus a follow-up to repair it is worse
-- than one correct file. Section 0 undoes the earlier shapes so staging can
-- re-run it from scratch and land somewhere clean.
--
--   FIRST: the handle backfill derived from display_name alone, and staging
--   showed 86 of 99 members coming out as `member_0014` because their nickname
--   was empty and their real name was never consulted. full_name became a tier.
--
--   SECOND: the identifier was a sequential member_number, and the club owner
--   replaced it with a 7-character code. Everything about that decision, and
--   why the code is a hash of the row's id rather than anything random, is in
--   section 3.
--
-- Both backfills are WHERE <column> IS NULL, so re-running after nulling the
-- column is the whole re-derivation. Nothing about a re-run is order-dependent
-- except which of two colliding rows gets the un-suffixed value, and that is
-- pinned by a fixed (created_at, id) walk.
--
-- WHAT CHANGES VISIBLY: get_leaderboard() returned COALESCE(display_name,
-- full_name) as `name`, so a member who had set a nickname was shown by it on a
-- PUBLIC page. It now returns full_name, and the nickname is gone from the UI
-- entirely — so those members will suddenly be shown under their real name,
-- with their handle beside it. That is the intended shape of "one chosen name",
-- but it is a visible change to real people and is called out here rather than
-- discovered.
-- ============================================================

-- ---- 0. Undo the earlier shapes of THIS file ---------------
-- Staging has run 00092 twice already, once with a sequential member_number and
-- once with a 5-digit one. Both are gone; the identifier is a 7-character code
-- now. These drops are what let staging re-run this file from scratch and land
-- somewhere clean, and they are all no-ops on production, which has never seen
-- any version of it.
--
-- DROP COLUMN, not a rename: the values were sequential integers and none of
-- them survives the change, so carrying them across would only preserve the
-- numbering that was rejected.
DROP FUNCTION IF EXISTS public.assign_member_number(UUID);
DROP FUNCTION IF EXISTS public.derive_member_number(UUID);
DROP SEQUENCE IF EXISTS public.player_member_number_seq;
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_member_number_range_check;
DROP INDEX IF EXISTS public.players_member_number_idx;
ALTER TABLE public.players DROP COLUMN IF EXISTS member_number;

-- ---- 1. The columns ----------------------------------------
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS handle TEXT;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS member_code TEXT;

-- The shape, stated by the database rather than only by the app. The server
-- action folds case before it writes, so a stored value is always lowercase and
-- this refuses anything that got in around it. 3–20 characters, [a-z0-9_], and
-- a letter first.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_handle_shape_check;
ALTER TABLE public.players ADD CONSTRAINT players_handle_shape_check
  CHECK (handle IS NULL OR handle ~ '^[a-z][a-z0-9_]{2,19}$');

-- The reserved names (admin, exec, root, …) are deliberately NOT here. They are
-- a club policy about what reads badly next to somebody's photo, they will
-- change, and a CHECK is the wrong place for a list that changes — see
-- RESERVED_HANDLES in packages/shared/src/utils/member-identity.ts.

-- THE ALPHABET IS PART OF THE CONTRACT, not a formatting detail. A member code
-- gets read aloud at the door and typed off a phone screen, so the characters
-- that cannot be told apart in those two situations are simply not in it:
-- 0/O and 1/I/L are gone, and U goes too (Crockford drops it, and it is what
-- keeps a random seven-character string from occasionally spelling something
-- the club would have to apologise for). What is left is
-- 23456789ABCDEFGHJKMNPQRSTVWXYZ — 30 characters.
--
-- UPPERCASE ONLY, and that is why there is no lower()/upper() index below.
-- handle needs one because members TYPE handles and will type `Kiera`; nobody
-- ever types a member code — it is assigned, never entered — so the CHECK can
-- simply refuse any casing but the canonical one. With exactly one legal
-- spelling of every code, a plain UNIQUE is already case-insensitive. If a
-- look-up by code is ever added (a door kiosk is the obvious one), it must
-- upper() its input before matching; that is the only case this leaves open,
-- and it is stated here so whoever adds it does not discover it.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_member_code_shape_check;
ALTER TABLE public.players ADD CONSTRAINT players_member_code_shape_check
  CHECK (member_code IS NULL OR member_code ~ '^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{7}$');

COMMENT ON COLUMN public.players.handle IS
  'The member''s one chosen name, written @handle and searched by it. Replaces display_name, which is kept but no longer written or shown. NULL only for a member who has not been given or chosen one — every member existing when 00092 landed was backfilled from their display_name. Public. Lowercase by construction (folded on write) and unique case-insensitively via players_handle_lower_idx. Ordinary profile data: a member sets their OWN through updateProfile() and it is deliberately NOT guarded by guard_player_privileged_columns, because guarding it is exactly what would stop them.';

COMMENT ON COLUMN public.players.display_name IS
  'RETIRED by 00092 and kept only as evidence. Nothing writes it and nothing displays it; players.handle is the member''s chosen name now. Preserved because every handle was derived from this text and a derivation over free text is a judgement call — this is what a wrong one is corrected from.';

COMMENT ON COLUMN public.players.member_code IS
  'The club''s membership code: 7 characters from 23456789ABCDEFGHJKMNPQRSTVWXYZ, e.g. K3F9TQ2. Assigned once by assign_member_code() when a person becomes a member, never changed and never reused. Derived from md5(players.id) so it is stable across a re-run of the backfill, NOT sequential — a counter would publish join order, which is a fact about a person the club never chose to share. Public and uppercase-only by CHECK. NOT a university student number and must never be used as one. Privileged: guarded by guard_player_privileged_columns and in PLAYER_FIELD_FLOOR, so nobody below admin can write it and no capability reaches it — it is assigned, never edited.';

-- ---- 2. Uniqueness, stated where it cannot be got around ----
-- On lower(handle) rather than on handle, and for the reason 00066 gives for
-- doing the same to email: a plain UNIQUE would let `Kiera` and `kiera` both
-- exist, which for a display name is not two rows, it is impersonation. NULLs
-- are not compared by a btree unique index, so any number of members with no
-- handle is fine.
--
-- This index, not a read-then-write, is what actually decides a claim. Two
-- people can type the same handle in the same second and both pass any check
-- the application makes first; the second writer is refused here whatever the
-- code believed, and updateProfile() translates the violation into "That handle
-- is taken."
CREATE UNIQUE INDEX IF NOT EXISTS players_handle_lower_idx
  ON public.players (lower(handle));

-- Plain, not lower()/upper(): see the CHECK above — one legal spelling.
CREATE UNIQUE INDEX IF NOT EXISTS players_member_code_idx
  ON public.players (member_code);

-- ---- 3. Where the codes come from --------------------------
-- A 7-CHARACTER CODE DERIVED FROM THE ROW'S OWN id. K3F9TQ2, not #0002.
--
-- The club owner's call, and the reasoning behind it is worth keeping. A
-- sequential number reads as a placeholder — `#0001` looks like the field has
-- not been filled in yet — and, worse, it PUBLISHES JOIN ORDER. This value is
-- public: a counter tells everyone who was third through the door and who was
-- ninety-seventh, which is a fact about a person the club never decided to
-- share.
--
-- WHY NOT gen_random_uuid() OR random(). The backfill below must produce the
-- same codes on every run. This file is re-runnable by design and has already
-- been re-run on staging; a random code would give every member a different
-- identity on each run, which is the exact opposite of what a permanent
-- identifier is for.
--
-- SO IT IS A HASH OF players.id, which is a UUID primary key: unique, never
-- reused, and never rewritten for the life of the row. Same input, same output,
-- forever.
--
--   md5(), not hashtext(). hashtext() is faster and is exactly the wrong tool
--   here: its algorithm is an internal implementation detail that has changed
--   between major Postgres versions, so an upgrade would silently reissue every
--   code in the club. md5() is specified and will produce the same bytes in ten
--   years.
--
--   40 bits, not 32. `('x' || <8 hex digits>)::bit(32)::int` is the usual idiom
--   and it can come out NEGATIVE, because the top bit lands on int4's sign bit.
--   Ten hex digits fold to bit(28+12) = bit(40), which is comfortably inside
--   bigint's positive range, and 40 bits is more than the ~34.3 the alphabet
--   needs (30^7 = 21,870,000,000). The residual modulo bias is about 0.6% and
--   matters to nothing here.
--
-- COLLISIONS ARE HANDLED, NOT HOPED ABOUT. 21.87 billion codes and ~100 members
-- makes a collision vanishingly unlikely, but the column is unique and a
-- collision at approval time would fail somebody's admission — an unlikely
-- event with a real cost is still an event. A taken code is REHASHED with an
-- attempt counter (md5 of 'id:1', then 'id:2', …) rather than incremented,
-- because incrementing walks into whatever sits next to it in the alphabet
-- while a rehash lands somewhere unrelated. The counter starts at 0 and the
-- backfill walks rows in a fixed order, so the same input resolves the same way
-- on every run.
CREATE OR REPLACE FUNCTION public.derive_member_code(p_player_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  -- Kept in step with MEMBER_CODE_ALPHABET in
  -- packages/shared/src/utils/member-identity.ts by hand, the same way the
  -- shape CHECK above is.
  v_alphabet CONSTANT TEXT := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_space    CONSTANT BIGINT := 21870000000;  -- 30^7
  v_attempt  INTEGER := 0;
  v_n        BIGINT;
  v_code     TEXT;
  i          INTEGER;
BEGIN
  LOOP
    -- Attempt 0 is the plain id, so the overwhelmingly common case hashes the
    -- id and nothing else.
    v_n := (('x' || substr(
              md5(p_player_id::text || CASE WHEN v_attempt = 0 THEN '' ELSE ':' || v_attempt::text END),
              1, 10))::bit(40)::bigint) % v_space;

    v_code := '';
    FOR i IN 1..7 LOOP
      v_code := substr(v_alphabet, (v_n % 30)::int + 1, 1) || v_code;
      v_n := v_n / 30;
    END LOOP;

    EXIT WHEN NOT EXISTS (SELECT 1 FROM players WHERE member_code = v_code);

    v_attempt := v_attempt + 1;
    IF v_attempt > 1000 THEN
      RAISE EXCEPTION 'Could not derive a free member code for % after 1000 attempts', p_player_id;
    END IF;
  END LOOP;
  RETURN v_code;
END;
$function$;

COMMENT ON FUNCTION public.derive_member_code(UUID) IS
  'The first free 7-character member code for this player: md5(id) folded into 30^7 over the alphabet 23456789ABCDEFGHJKMNPQRSTVWXYZ, rehashed with an attempt counter if that code is taken. Deterministic — the same row in the same database always gets the same answer, which is what makes 00092''s backfill re-runnable. Reads the table, so STABLE rather than IMMUTABLE.';

-- Deliberately NOT a column DEFAULT. A default fires on INSERT, which is when
-- somebody SIGNS UP, and a signup is not yet a member — and it would also make
-- `NEW.member_code IS NOT NULL` true on every insert, so the guard below would
-- have to reject every signup or never fire at all. The code is stamped at
-- approval instead.

-- ---- 4. Backfill: the codes --------------------------------
-- Ordered by created_at with id as the tiebreaker, because created_at can tie
-- and the collision rehash's answer depends on who was assigned first. Only
-- rows with member_code IS NULL are touched, so a second run is a no-op rather
-- than a reissue.
--
-- The ORDER does not decide the codes themselves — those come from the id — but
-- it still decides how a collision resolves, so it stays fixed.
--
-- pending_approval rows are EXCLUDED. A pending signup is not a member yet, and
-- the whole point of assigning at approval is that the code means "the club let
-- this person in". They get theirs from assign_member_code() the moment
-- somebody approves them.
DO $$
DECLARE
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT id
      FROM players
     WHERE member_code IS NULL
       AND status <> 'pending_approval'
     ORDER BY created_at, id
  LOOP
    UPDATE players SET member_code = derive_member_code(v_row.id) WHERE id = v_row.id;
  END LOOP;
END;
$$;

-- ---- 5. Assignment -----------------------------------------
-- Called by approvePlayer() and createPlayer() in the admin console — the two
-- points at which a person becomes a member. A function rather than a trigger
-- on status, because "became a member" is a decision the console makes and
-- names, not a shape a row happens to take: removePlayer() writes
-- status = 'suspended' and reinstatement writes a division back, and a
-- status-watching trigger would have to enumerate which of those count.
--
-- Idempotent. A row that already has a code keeps it, so a re-approval, a
-- double click or a retry after an unclear outcome all leave it alone. That is
-- also what makes the pending_approval exclusion above harmless in either
-- direction.
--
-- THE RETRY LOOP IS NOT BELT AND BRACES. derive_member_code() probes against
-- what is committed when it reads, so two approvals racing on two rows that
-- hashed to the same code can both be handed it. The unique index refuses the
-- second — correctly — and without this the approval it belonged to would fail
-- outright, which is a real decision lost to a coin flip nobody saw. On the
-- retry the winner's code is committed and visible, so the rehash steps past
-- it. Bounded, so a genuinely exhausted space still stops.
CREATE OR REPLACE FUNCTION public.assign_member_code(p_player_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_code    TEXT;
  v_attempt INTEGER;
BEGIN
  SELECT member_code INTO v_code FROM players WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not found';
  END IF;
  IF v_code IS NOT NULL THEN
    RETURN v_code;
  END IF;

  FOR v_attempt IN 1..25 LOOP
    BEGIN
      v_code := derive_member_code(p_player_id);
      UPDATE players SET member_code = v_code WHERE id = p_player_id;
      RETURN v_code;
    EXCEPTION WHEN unique_violation THEN
      -- Somebody committed that code between the probe and the write. Their row
      -- is visible now, so the next rehash steps over it.
    END;
  END LOOP;

  RAISE EXCEPTION 'Could not assign a member code to % after 25 attempts', p_player_id;
END;
$function$;

COMMENT ON FUNCTION public.assign_member_code(UUID) IS
  'Stamps players.member_code the first time it is called for a row, from derive_member_code(), and returns the existing code every time after. Called by approvePlayer() and createPlayer(); never reachable by a member.';

-- SECURITY DEFINER and carrying no is_admin check of its own, so it must not be
-- reachable by a direct PostgREST rpc call from a member's own JWT. Only the
-- console's service-role client invokes it. derive_member_code() is locked down
-- alongside it: it reads no private data, but it is the other half of the same
-- operation and there is no reason for a member to be able to call it.
REVOKE EXECUTE ON FUNCTION public.assign_member_code(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.assign_member_code(UUID)
  TO service_role;
REVOKE EXECUTE ON FUNCTION public.derive_member_code(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.derive_member_code(UUID)
  TO service_role;

-- ---- 5b. Handles, derived from the names already on the row --
-- THIS IS A DATA MIGRATION WITH JUDGEMENT IN IT, not a rename. The source text
-- is free text: it has spaces, capitals and punctuation, it is very often just
-- a first name, and IT IS NOT UNIQUE — this club has two Matthews, two Graces
-- and several Biancas. So the derivation is spelled out rather than left
-- implicit, and it is a named function because it is applied to two different
-- source texts:
--
--   1. lowercase;
--   2. every run of anything outside [a-z0-9_] becomes a single '_', and runs
--      of '_' collapse to one;
--   3. leading non-letters dropped, because a handle must start with a letter;
--   4. truncated to 20, then any trailing '_' the truncation exposed is dropped.
--
-- THE full_name TIER IS THE WHOLE POINT OF THIS SECTION, and its absence is why
-- this file was corrected rather than followed by a fixer. The first version
-- derived from display_name alone. On staging that produced `member_0014` for
-- 86 of 99 members — every one of them a member whose nickname was empty, which
-- is most of the club — while their real name sat unused one column over. A
-- backfill that hands out numeric handles to 87% of the roster is not a
-- backfill, so full_name is consulted before any fallback is.
--
-- WHY full_name AND NOT JUST THE FIRST NAME. `umar_ueda` rather than `umar`.
-- First names alone are prettier and collide constantly: three Biancas means
-- two of them get pushed onto the tiebreak tier, and `bianca_2` tells a reader
-- less than `bianca_chen` does. first_last is nearly always unique in a club
-- this size, and the tiebreak is still there for when it is not.
--
-- The ladder, checked in full — shape, reserved, and free — at EVERY tier
-- rather than only at the base. A display name of literally "matthew 2" derives
-- to `matthew_2`, which is exactly what the tiebreak tier produces for the
-- OTHER Matthew:
--
--   tier 1  the nickname base. The member's own chosen text wins when they
--           gave one.
--   tier 2  the full-name base. This is where most of the club lands, and it
--           is also the better answer for the second Matthew, who gets
--           `matthew_cheng` rather than a suffix.
--   tier 3  that base with `_2`, `_3`, … appended, first free wins.
--   tier 4  'member_' + the member code, lowercased: `member_k3f9tq2`. Unique
--           by construction, because the code is. Reached only by a member with
--           no usable text in EITHER name — blank, punctuation-only,
--           emoji-only — which after the full_name tier should be nobody.
--
-- TIER 3 IS A PLAIN COUNTER, NOT THE MEMBER CODE, and that is a deliberate
-- decoupling. It used to be the member number, which meant `matthew_6`; with a
-- code that spelling becomes `matthew_k3f9tq2`, which is not a name anybody
-- would answer to. A counter also reads correctly — `matthew_2` IS the second
-- Matthew — and, more importantly, it means the identifier scheme and the
-- handle scheme no longer move together. This file has already changed its
-- identifier twice and dragged every handle with it both times; it cannot do
-- that a third time.
--
-- Determinism survives the change: the counter is resolved against handles
-- already taken, and the loop walks rows in a fixed (created_at, id) order, so
-- the same starting state always produces the same handles.
--
-- If nothing in the ladder is free the loop RAISES rather than leaving a member
-- without a handle. Staging gets this first, so a loud failure is the cheap
-- outcome and a silent NULL is the expensive one.
--
-- DETERMINISTIC AND RE-RUNNABLE: only rows with handle IS NULL are touched, so
-- running this twice produces the same handles and the second run does nothing.
-- Re-deriving after a correction is therefore "null the handles, run this
-- again".
--
-- MIRRORED IN TYPESCRIPT. deriveHandleBase() and deriveHandle() in
-- packages/shared/src/utils/member-identity.ts are this same ladder, kept in
-- step by hand — the same arrangement name.ts has with 00023 — so the tiers can
-- be exercised against real names without a database. The empty-nickname case
-- above is exactly what that test now pins.
--
-- pending_approval rows are skipped, because they have no member code to build
-- a fallback from and are not members yet. They choose their own handle in
-- /settings like any new member.

CREATE OR REPLACE FUNCTION public.derive_handle_base(p_source TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT regexp_replace(
           left(
             regexp_replace(
               regexp_replace(
                 regexp_replace(lower(COALESCE(p_source, '')), '[^a-z0-9_]+', '_', 'g'),
                 '_+', '_', 'g'),
               '^[^a-z]+', ''),
             20),
           '_+$', '');
$function$;

DO $$
DECLARE
  -- Kept in step with RESERVED_HANDLES in
  -- packages/shared/src/utils/member-identity.ts by hand, the same way the
  -- shape CHECK above is. A backfill must not mint the names the app refuses.
  v_reserved TEXT[] := ARRAY['admin', 'exec', 'root', 'me', 'settings', 'api', 'support', 'sfu', 'club'];
  v_row          RECORD;
  v_nick_base    TEXT;
  v_name_base    TEXT;
  v_tiebreak     TEXT;
  v_suffix       TEXT;
  v_candidates   TEXT[];
  v_try          TEXT;
  v_candidate    TEXT;
  v_n            INTEGER;
BEGIN
  FOR v_row IN
    SELECT id, display_name, full_name, member_code
      FROM players
     WHERE handle IS NULL
       AND member_code IS NOT NULL
     ORDER BY created_at, id
  LOOP
    v_nick_base := derive_handle_base(v_row.display_name);
    v_name_base := derive_handle_base(v_row.full_name);
    -- The member's own text is preferred for the suffixed form too: someone who
    -- chose "Matthew" should become matthew_2 rather than matthew_cheng_2.
    v_tiebreak  := COALESCE(NULLIF(v_nick_base, ''), v_name_base);

    -- The whole ladder as one ordered list, so there is a single predicate
    -- below rather than the same three tests written out four times.
    v_candidates := ARRAY[v_nick_base, v_name_base];
    IF v_tiebreak <> '' THEN
      FOR v_n IN 2..99 LOOP
        v_suffix := '_' || v_n::text;
        v_candidates := v_candidates
          || (regexp_replace(left(v_tiebreak, 20 - length(v_suffix)), '_+$', '') || v_suffix);
      END LOOP;
    END IF;
    v_candidates := v_candidates || ('member_' || lower(v_row.member_code));

    v_candidate := NULL;
    FOREACH v_try IN ARRAY v_candidates LOOP
      CONTINUE WHEN v_try IS NULL;
      CONTINUE WHEN v_try !~ '^[a-z][a-z0-9_]{2,19}$';
      CONTINUE WHEN v_try = ANY (v_reserved);
      CONTINUE WHEN EXISTS (SELECT 1 FROM players WHERE lower(handle) = v_try);
      v_candidate := v_try;
      EXIT;
    END LOOP;

    IF v_candidate IS NULL THEN
      RAISE EXCEPTION 'Could not derive a free handle for player % (member %)', v_row.id, v_row.member_code;
    END IF;

    UPDATE players SET handle = v_candidate WHERE id = v_row.id;
  END LOOP;
END;
$$;

-- Dropped on the way out. It exists for the backfill above and has no second
-- caller: handles are chosen by members from here on, and leaving a helper
-- behind invites somebody to build on a function whose only contract is "what
-- 00092 happened to need".
DROP FUNCTION IF EXISTS public.derive_handle_base(TEXT);

-- ---- 6. Both columns are public ----------------------------
-- 00032 revoked blanket SELECT on players and hands out a column list instead,
-- so a new column is invisible to `authenticated` until it is named here. Both
-- of these are meant to be seen by other members — that is what a handle IS —
-- and neither is contact detail or a moderation flag.
GRANT SELECT (handle, member_code) ON public.players TO authenticated;

-- ---- 7. The guard, replaced wholesale ----------------------
-- RECONSTRUCTED FROM 00087, WHICH IS THE LATEST DEFINITION IN THIS REPOSITORY
-- (00088–00091 do not touch this function; checked). member_code is added to
-- both branches and NOTHING ELSE IS CHANGED. CREATE OR REPLACE takes the whole
-- body, so a line dropped from memory is a guard silently removed — see the
-- header of 00072, where a reconstruction from memory would have dropped
-- status, is_banned and active_flag. **Before applying this, dump the live
-- definition and diff it against 00087's**: if anything has been changed in the
-- database since, that change is not in this file and this statement will
-- delete it.
--
-- WHY member_code BELONGS HERE. players_update_own (00005) lets a member PATCH
-- their own row through PostgREST with their own JWT, and `authenticated` still
-- holds table-level UPDATE. Without this line a member could choose their own
-- membership code — take a memorable one, take somebody else's and collide, or
-- change it after the fact so a code somebody wrote down stops resolving. It is
-- not privilege, but it is an identity the club assigns and only the club
-- assigns.
--
-- WHY handle DOES NOT. Setting their own handle is the entire feature. Adding
-- it here would refuse the one write this whole migration exists to allow.
--
-- Plain IS NOT NULL on the INSERT branch is correct for member_code: the
-- column is nullable with no default, so a self-created row genuinely has none
-- unless the caller supplied one. (Contrast permission_grants, which is NOT
-- NULL with a '{}' default and therefore needs cardinality().)
CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- auth.uid() IS NULL covers the service-role console, which has already
  -- checked the caller's level in a server action.
  IF auth.uid() IS NULL OR is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A self-created row may only ever be an ordinary, unapproved member.
    IF COALESCE(NEW.is_exec, FALSE)
       OR COALESCE(NEW.is_trainer, FALSE)
       OR COALESCE(NEW.fee_exempt, FALSE)
       OR COALESCE(NEW.is_banned, FALSE)
       OR NEW.role IS DISTINCT FROM 'player'
       OR NEW.status IS DISTINCT FROM 'pending_approval'
       -- Added: a self-created row claiming an office is the same escalation as
       -- editing one in, and get_executives() would publish it.
       OR NEW.exec_title IS NOT NULL
       -- REPLACES 00086's portfolio line, for the same reason it existed: a
       -- self-created row cannot be an exec at all (is_exec is refused above),
       -- so permissions on one are meaningless — but they must not be a way to
       -- pre-stage values that come into force the moment an admin grants
       -- is_exec. cardinality(), not IS NOT NULL: see the note above.
       OR NEW.permission_role IS NOT NULL
       OR cardinality(COALESCE(NEW.permission_grants, '{}')) > 0
       OR cardinality(COALESCE(NEW.permission_revokes, '{}')) > 0
       -- Added by 00092: signing up is not the club letting you in, so a signup
       -- that arrives already numbered is claiming a membership nobody granted.
       OR NEW.member_code IS NOT NULL THEN
      RAISE EXCEPTION 'Not authorized to create a privileged player row';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role            IS DISTINCT FROM OLD.role
     OR NEW.status       IS DISTINCT FROM OLD.status
     OR NEW.is_banned    IS DISTINCT FROM OLD.is_banned
     OR NEW.is_exec      IS DISTINCT FROM OLD.is_exec
     OR NEW.eligibility_flag IS DISTINCT FROM OLD.eligibility_flag
     OR NEW.fee_exempt   IS DISTINCT FROM OLD.fee_exempt
     OR NEW.active_flag  IS DISTINCT FROM OLD.active_flag
     OR NEW.waiver_reset_at IS DISTINCT FROM OLD.waiver_reset_at
     OR NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at
     OR NEW.membership_type IS DISTINCT FROM OLD.membership_type
     OR NEW.exec_photo_url IS DISTINCT FROM OLD.exec_photo_url
     -- Published to anonymous visitors by get_executives(), so an unguarded
     -- write is a public claim to an office the member does not hold, not a
     -- cosmetic field on their own profile.
     OR NEW.exec_title   IS DISTINCT FROM OLD.exec_title
     -- THE 00087 REPLACEMENT for 00086's portfolio line. All three, because
     -- omitting any one of them leaves a complete escalation path: the role
     -- alone chooses the base, a grant alone adds to it, and clearing a revoke
     -- alone hands back whatever the club took away.
     OR NEW.permission_role IS DISTINCT FROM OLD.permission_role
     OR NEW.permission_grants IS DISTINCT FROM OLD.permission_grants
     OR NEW.permission_revokes IS DISTINCT FROM OLD.permission_revokes
     -- Added by 00092. Assigned once by assign_member_code() and permanent;
     -- there is no legitimate self-edit, including clearing it.
     OR NEW.member_code IS DISTINCT FROM OLD.member_code
     OR NEW.is_trainer   IS DISTINCT FROM OLD.is_trainer THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.guard_player_privileged_columns() IS
  'Blocks a member from granting themselves privilege via a direct PostgREST write to their own players row. Replaced wholesale on every change: CREATE OR REPLACE takes the whole body, so a column omitted here loses its protection silently. Dump the live definition before editing.';

-- ---- 8. The leaderboard carries the handle -----------------
-- The ladder is where "searchable by @handle" is actually used, and the RPC it
-- reads did not return one. DROP + CREATE rather than CREATE OR REPLACE for the
-- reason 00021 gives: the RETURNS TABLE signature changes and REPLACE cannot
-- change a return type. The body is 00021's, with two edits and nothing else.
--
-- EDIT 1: `name` is now full_name, where it was COALESCE(display_name,
-- full_name). This is the retirement of the nickname, and it is a visible change
-- on a PUBLIC page — see the header. The handle travels beside the name rather
-- than instead of it, because a leaderboard row reading only `@kiera` tells a
-- reader less than `Kiera Watanabe · @kiera` does.
--
-- EDIT 2: handle added to the returned columns.
--
-- DROP takes the grants with it, so 00021's GRANT is restated verbatim below.
-- Without it the leaderboard is a 403 for every visitor, signed in or not.
DROP FUNCTION IF EXISTS public.get_leaderboard();

CREATE FUNCTION public.get_leaderboard()
 RETURNS TABLE(
   id uuid, name text, handle text, status player_status, avatar_url text,
   singles_elo integer, doubles_elo integer,
   singles_wins integer, singles_losses integer,
   doubles_wins integer, doubles_losses integer,
   singles_provisional boolean, doubles_provisional boolean,
   current_singles_streak integer, current_doubles_streak integer,
   tournament_points integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    p.id, p.full_name AS name, p.handle, p.status, p.avatar_url,
    r.singles_elo, r.doubles_elo,
    r.singles_wins, r.singles_losses, r.doubles_wins, r.doubles_losses,
    r.singles_provisional, r.doubles_provisional,
    r.current_singles_streak, r.current_doubles_streak,
    COALESCE(tp.pts, 0)::int AS tournament_points
  FROM players p
  JOIN ratings r ON r.player_id = p.id
  LEFT JOIN (
    SELECT tpa.player_id, SUM(tpa.points)::int AS pts
    FROM tournament_participants tpa
    WHERE tpa.status NOT IN ('withdrawn', 'disqualified') AND tpa.points > 0
    GROUP BY tpa.player_id
  ) tp ON tp.player_id = p.id
  WHERE p.active_flag = TRUE
    AND p.hide_from_leaderboard = FALSE
    AND p.status NOT IN ('pending_approval', 'suspended');
$function$;

GRANT EXECUTE ON FUNCTION public.get_leaderboard() TO authenticated, anon, service_role;

-- New columns, a new function and a changed signature, so PostgREST's cached
-- schema is stale until it is told otherwise — without this the handle write,
-- the assignment RPC and the leaderboard all fail until the next restart.
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- If either unique index above failed, these show what it found
-- ============================================================
-- SELECT lower(handle), count(*) FROM players
--  WHERE handle IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
--
-- SELECT member_code, count(*) FROM players
--  WHERE member_code IS NOT NULL GROUP BY 1 HAVING count(*) > 1;

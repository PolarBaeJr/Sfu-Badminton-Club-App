-- ============================================================
-- 00092 — one chosen name per member, and a number the club assigns
--
-- Two identifiers, and they are two different kinds of thing:
--
--   handle         the member's ONE chosen name. Unique, written `@kiera`,
--                  and the thing you search by. It REPLACES the free-text
--                  "display name / nickname" the app has been showing.
--   member_number  assigned by the club, sequential, permanent, never reused,
--                  never typed by anyone. Backfilled below, and stamped on
--                  everyone after that by assign_member_number().
--
-- member_number is NOT a university student number and must never become one.
-- No SFU record is stored anywhere near this column; it is the club's own count
-- of who joined in what order.
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
-- WHAT CHANGES VISIBLY: get_leaderboard() returned COALESCE(display_name,
-- full_name) as `name`, so a member who had set a nickname was shown by it on a
-- PUBLIC page. It now returns full_name, and the nickname is gone from the UI
-- entirely — so those members will suddenly be shown under their real name,
-- with their handle beside it. That is the intended shape of "one chosen name",
-- but it is a visible change to real people and is called out here rather than
-- discovered.
-- ============================================================

-- ---- 1. The columns ----------------------------------------
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS handle TEXT;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS member_number INTEGER;

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

COMMENT ON COLUMN public.players.handle IS
  'The member''s one chosen name, written @handle and searched by it. Replaces display_name, which is kept but no longer written or shown. NULL only for a member who has not been given or chosen one — every member existing when 00092 landed was backfilled from their display_name. Public. Lowercase by construction (folded on write) and unique case-insensitively via players_handle_lower_idx. Ordinary profile data: a member sets their OWN through updateProfile() and it is deliberately NOT guarded by guard_player_privileged_columns, because guarding it is exactly what would stop them.';

COMMENT ON COLUMN public.players.display_name IS
  'RETIRED by 00092 and kept only as evidence. Nothing writes it and nothing displays it; players.handle is the member''s chosen name now. Preserved because every handle was derived from this text and a derivation over free text is a judgement call — this is what a wrong one is corrected from.';

COMMENT ON COLUMN public.players.member_number IS
  'The club''s own membership number, assigned once by assign_member_number() when a person becomes a member and never changed or reused. Public, displayed zero-padded as #0042. NOT a university student number and must never be used as one. Privileged: guarded by guard_player_privileged_columns and in PLAYER_FIELD_FLOOR, so nobody below admin can write it and no capability reaches it — it is assigned, never edited.';

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

CREATE UNIQUE INDEX IF NOT EXISTS players_member_number_idx
  ON public.players (member_number);

-- ---- 3. Where the numbers come from ------------------------
-- A sequence, so two approvals happening at once cannot be handed the same
-- number. `SELECT max(member_number) + 1` in application code is the version of
-- this that races, and nextval() is the version that cannot.
--
-- Deliberately NOT a column DEFAULT. A default fires on INSERT, which is when
-- somebody SIGNS UP, and a signup is not yet a member — and it would also make
-- `NEW.member_number IS NOT NULL` true on every insert, so the guard below
-- would have to reject every signup or never fire at all. The number is stamped
-- at approval instead.
CREATE SEQUENCE IF NOT EXISTS public.player_member_number_seq AS INTEGER START WITH 1;

-- ---- 4. Backfill: the numbers ------------------------------
-- Deterministic: ordered by created_at with id as the tiebreaker, because
-- created_at can tie and "ordered by created_at" alone would hand out different
-- numbers on a re-run. WHERE member_number IS NULL, so a second run is a no-op
-- rather than a renumbering.
--
-- pending_approval rows are EXCLUDED. A pending signup is not a member yet, and
-- the whole point of assigning at approval is that the number means "the club
-- let this person in". They get theirs from assign_member_number() the moment
-- somebody approves them.
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS n
    FROM public.players
   WHERE member_number IS NULL
     AND status <> 'pending_approval'
)
UPDATE public.players p
   SET member_number = ordered.n
  FROM ordered
 WHERE p.id = ordered.id;

-- Three-argument setval with is_called = false, so the NEXT nextval() returns
-- exactly this value. The COALESCE handles a database with no members at all:
-- setval(seq, 0) would raise, because the sequence's MINVALUE is 1.
SELECT setval(
  'public.player_member_number_seq',
  COALESCE((SELECT max(member_number) + 1 FROM public.players), 1),
  false
);

-- ---- 5. Assignment -----------------------------------------
-- Called by approvePlayer() and createPlayer() in the admin console — the two
-- points at which a person becomes a member. A function rather than a trigger
-- on status, because "became a member" is a decision the console makes and
-- names, not a shape a row happens to take: removePlayer() writes
-- status = 'suspended' and reinstatement writes a division back, and a
-- status-watching trigger would have to enumerate which of those count.
--
-- Idempotent. A row that already has a number keeps it and no sequence value is
-- burned, so a re-approval, a double click or a retry after an unclear outcome
-- all leave the number alone. That is also what makes the pending_approval
-- exclusion above harmless in either direction.
CREATE OR REPLACE FUNCTION public.assign_member_number(p_player_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_number INTEGER;
BEGIN
  SELECT member_number INTO v_number FROM players WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not found';
  END IF;
  IF v_number IS NOT NULL THEN
    RETURN v_number;
  END IF;

  v_number := nextval('player_member_number_seq');
  UPDATE players SET member_number = v_number WHERE id = p_player_id;
  RETURN v_number;
END;
$function$;

COMMENT ON FUNCTION public.assign_member_number(UUID) IS
  'Stamps players.member_number from player_member_number_seq the first time it is called for a row, and returns the existing number every time after. Called by approvePlayer() and createPlayer(); never reachable by a member.';

-- SECURITY DEFINER and carrying no is_admin check of its own, so it must not be
-- reachable by a direct PostgREST rpc call from a member's own JWT. Only the
-- console's service-role client invokes it.
REVOKE EXECUTE ON FUNCTION public.assign_member_number(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.assign_member_number(UUID)
  TO service_role;

-- ---- 5b. Handles, derived from the retired nicknames --------
-- THIS IS A DATA MIGRATION WITH JUDGEMENT IN IT, not a rename. display_name is
-- free text: it has spaces, capitals and punctuation, it is very often just a
-- first name, and IT IS NOT UNIQUE — this club has two Matthews, two Graces and
-- several Biancas. So the derivation is spelled out rather than left implicit:
--
--   1. lowercase;
--   2. every run of anything outside [a-z0-9_] becomes a single '_', and runs
--      of '_' collapse to one;
--   3. leading non-letters dropped, because a handle must start with a letter;
--   4. truncated to 20, then any trailing '_' the truncation exposed is dropped.
--
-- Then a three-tier ladder, checking the FINAL candidate for uniqueness at each
-- step rather than only the base — a display name of literally "matthew 43"
-- derives to `matthew_43`, which is exactly what tier 2 would produce for the
-- OTHER Matthew:
--
--   tier 1  the derived base, if it is valid, unreserved and free;
--   tier 2  the base with '_<member_number>' appended (the base truncated to
--           make room). Never collides with another tier 2, because member
--           numbers are unique;
--   tier 3  'member_0042'. Cannot collide with anything, because it is built
--           from the unique number alone. This is where an empty derivation
--           lands — a display name that was blank, or only punctuation, or only
--           emoji, strips to nothing at step 3 and has no base to tier 2 with.
--
-- If all three are somehow taken the loop RAISES rather than leaving a member
-- without a handle. Staging gets this first, so a loud failure is the cheap
-- outcome and a silent NULL is the expensive one.
--
-- DETERMINISTIC AND RE-RUNNABLE: rows are processed in (created_at, id) — the
-- same order the member numbers were handed out in — and only rows with
-- handle IS NULL are touched, so running this twice produces the same handles
-- and the second run does nothing.
--
-- pending_approval rows are skipped, because they have no member_number to
-- build a fallback from and are not members yet. They choose their own handle
-- in /settings like any new member.
DO $$
DECLARE
  -- Kept in step with RESERVED_HANDLES in
  -- packages/shared/src/utils/member-identity.ts by hand, the same way the
  -- shape CHECK above is. A backfill must not mint the names the app refuses.
  v_reserved TEXT[] := ARRAY['admin', 'exec', 'root', 'me', 'settings', 'api', 'support', 'sfu', 'club'];
  v_row       RECORD;
  v_base      TEXT;
  v_suffix    TEXT;
  v_candidate TEXT;
BEGIN
  FOR v_row IN
    SELECT id, display_name, member_number
      FROM players
     WHERE handle IS NULL
       AND member_number IS NOT NULL
     ORDER BY created_at, id
  LOOP
    v_base := lower(COALESCE(v_row.display_name, ''));
    v_base := regexp_replace(v_base, '[^a-z0-9_]+', '_', 'g');
    -- A second collapse, for the underscores that were ALREADY in the text:
    -- the pass above only collapses runs of characters it is replacing, so
    -- "a__b" would otherwise survive as typed.
    v_base := regexp_replace(v_base, '_+', '_', 'g');
    v_base := regexp_replace(v_base, '^[^a-z]+', '');
    v_base := left(v_base, 20);
    v_base := regexp_replace(v_base, '_+$', '');

    -- Tier 1.
    v_candidate := NULL;
    IF v_base ~ '^[a-z][a-z0-9_]{2,19}$'
       AND NOT (v_base = ANY (v_reserved))
       AND NOT EXISTS (SELECT 1 FROM players WHERE lower(handle) = v_base) THEN
      v_candidate := v_base;
    END IF;

    -- Tier 2. Needs a base that still starts with a letter after truncation;
    -- an empty one has nothing to disambiguate and goes straight to tier 3.
    IF v_candidate IS NULL AND v_base ~ '^[a-z]' THEN
      v_suffix := '_' || v_row.member_number::text;
      v_candidate := regexp_replace(left(v_base, 20 - length(v_suffix)), '_+$', '') || v_suffix;
      IF v_candidate !~ '^[a-z][a-z0-9_]{2,19}$'
         OR v_candidate = ANY (v_reserved)
         OR EXISTS (SELECT 1 FROM players WHERE lower(handle) = v_candidate) THEN
        v_candidate := NULL;
      END IF;
    END IF;

    -- Tier 3.
    IF v_candidate IS NULL THEN
      v_candidate := 'member_' || lpad(v_row.member_number::text, 4, '0');
      IF EXISTS (SELECT 1 FROM players WHERE lower(handle) = v_candidate) THEN
        RAISE EXCEPTION 'Could not derive a free handle for player % (member #%)', v_row.id, v_row.member_number;
      END IF;
    END IF;

    UPDATE players SET handle = v_candidate WHERE id = v_row.id;
  END LOOP;
END;
$$;

-- ---- 6. Both columns are public ----------------------------
-- 00032 revoked blanket SELECT on players and hands out a column list instead,
-- so a new column is invisible to `authenticated` until it is named here. Both
-- of these are meant to be seen by other members — that is what a handle IS —
-- and neither is contact detail or a moderation flag.
GRANT SELECT (handle, member_number) ON public.players TO authenticated;

-- ---- 7. The guard, replaced wholesale ----------------------
-- RECONSTRUCTED FROM 00087, WHICH IS THE LATEST DEFINITION IN THIS REPOSITORY
-- (00088–00091 do not touch this function; checked). member_number is added to
-- both branches and NOTHING ELSE IS CHANGED. CREATE OR REPLACE takes the whole
-- body, so a line dropped from memory is a guard silently removed — see the
-- header of 00072, where a reconstruction from memory would have dropped
-- status, is_banned and active_flag. **Before applying this, dump the live
-- definition and diff it against 00087's**: if anything has been changed in the
-- database since, that change is not in this file and this statement will
-- delete it.
--
-- WHY member_number BELONGS HERE. players_update_own (00005) lets a member
-- PATCH their own row through PostgREST with their own JWT, and `authenticated`
-- still holds table-level UPDATE. Without this line a member could pick their
-- own membership number — take #0001, or take a number the club has not reached
-- yet, or collide with somebody and simply fail. It is not privilege, but it is
-- an identity the club assigns and only the club assigns.
--
-- WHY handle DOES NOT. Setting their own handle is the entire feature. Adding
-- it here would refuse the one write this whole migration exists to allow.
--
-- Plain IS NOT NULL on the INSERT branch is correct for member_number: the
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
       OR NEW.member_number IS NOT NULL THEN
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
     -- Added by 00092. Assigned once by assign_member_number() and permanent;
     -- there is no legitimate self-edit, including clearing it.
     OR NEW.member_number IS DISTINCT FROM OLD.member_number
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
-- SELECT member_number, count(*) FROM players
--  WHERE member_number IS NOT NULL GROUP BY 1 HAVING count(*) > 1;

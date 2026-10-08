-- ============================================================
-- 00040_membership_type.sql — who a member is, and which events they may join
-- ============================================================
-- The club has three kinds of member and no way to say so. Fee tiers named
-- "Internal" and "External" already exist per tournament, but nothing connects
-- a person to one, so the tier is picked by hand every time and the default is
-- whichever tier an admin happened to flag.
--
-- More importantly some events are internal-only, some admit alumni, and some
-- are open — and today anyone who can see an event can register for it.
--
-- A SEPARATE axis from role/is_exec on purpose. An exec IS an internal member;
-- folding "exec" into this list would make that unrepresentable and would mean
-- promoting someone to exec silently changed which events they could enter.
-- role, is_exec and membership_type are all independent and may coexist.
--
-- NOT reusing eligibility_flag. It is a boolean that today gates exactly one
-- thing (the 'eligible_only' announcement audience) and cannot express three
-- values; overloading it would silently change who receives announcements.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE membership_type AS ENUM ('internal', 'alumni', 'external');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Default 'internal': every existing member is a current club member, and the
-- alternative (nullable, or defaulting to 'external') would lock the entire
-- roster out of internal-only events the moment the first one is created.
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS membership_type membership_type NOT NULL DEFAULT 'internal';

COMMENT ON COLUMN players.membership_type IS
  'Which membership group this person belongs to. Independent of role and is_exec — an exec is still an internal member. Drives tournament eligibility and which fee tier applies.';

CREATE INDEX IF NOT EXISTS idx_players_membership_type ON players(membership_type);

-- ------------------------------------------------------------
-- Per-tournament eligibility
-- ------------------------------------------------------------
-- An array rather than a single "minimum tier", because the groups are not
-- ranked: "internal + alumni" and "internal + external" are both real
-- combinations and neither is a prefix of the other.
--
-- Defaults to all three so every EXISTING tournament stays open exactly as it
-- is today. This migration must not retroactively bar anyone from an event
-- they can currently enter.
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS allowed_memberships membership_type[]
    NOT NULL DEFAULT ARRAY['internal', 'alumni', 'external']::membership_type[];

COMMENT ON COLUMN tournaments.allowed_memberships IS
  'Membership groups permitted to register. Defaults to all three (open). Enforced in the registration server action, which uses the service-role key and therefore bypasses RLS.';

-- An empty array would bar everyone including admins, which is never what
-- anyone means — it is the shape you get from a UI that deselected everything.
ALTER TABLE tournaments
  DROP CONSTRAINT IF EXISTS tournaments_allowed_memberships_not_empty;
ALTER TABLE tournaments
  ADD CONSTRAINT tournaments_allowed_memberships_not_empty
  CHECK (array_length(allowed_memberships, 1) >= 1);

-- ------------------------------------------------------------
-- Privileged-column guard
-- ------------------------------------------------------------
-- membership_type MUST be in this list. players_update_own lets a member
-- update their own row, so without this a player could set themselves to
-- 'internal' with a plain profile UPDATE and walk into an internal-only event.
-- Same reasoning that already covers role, status, is_exec and fee_exempt.
CREATE OR REPLACE FUNCTION guard_player_privileged_columns()
RETURNS TRIGGER AS $$
BEGIN
  -- service-role (no auth.uid()) and admins may change anything
  IF auth.uid() IS NULL OR is_admin(auth.uid()) THEN
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
     -- New in 00040. Self-setting this is a privilege escalation into
     -- internal-only events.
     OR NEW.membership_type IS DISTINCT FROM OLD.membership_type THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

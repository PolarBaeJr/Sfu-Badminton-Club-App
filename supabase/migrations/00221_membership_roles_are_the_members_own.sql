-- 00221 — @Internal, @Alumni and @External become the member's own pick.
--
-- WHAT CHANGED, AND WHY THE GUARD 00168 PUT HERE NO LONGER APPLIES TO THEM
--
-- 00168 refuses to let a SWEEP-MANAGED role be offered in the picker, in both
-- directions, and the reason it gives is exact:
--
--     "a sweep-managed role made self-assignable would be stripped from
--      everyone who clicked it at the next nightly reconcile — the button would
--      look broken and the sweep would look like it was misbehaving, and
--      neither would be."
--
-- That is still true of the six roles it protects. It is no longer true of the
-- three membership roles, because they are no longer swept: roleDiff() in
-- apps/bot/src/roles.ts now iterates SWEPT_ROLES, which is MANAGED_ROLES minus
-- MEMBERSHIP_ROLES, so the nightly reconcile neither adds nor removes them. The
-- premise of the guard is gone for exactly these three, so the guard is narrowed
-- to exactly the six it still describes.
--
-- THE ONE THING THAT STILL TAKES THEM OFF is a BAN or a tombstone — the club
-- withdrawing access rather than a member changing their mind — because
-- member-only channel visibility in this server IS @Internal + @Alumni. That is
-- roleDiff's `revokeMembership`, and it removes only; nothing anywhere adds one
-- any more. It does not touch the guard above: a banned member clicking the
-- button gets the role back and loses it again at the next sweep, which is
-- exactly what a banned member clicking any other button gets today.
--
-- THE DIRECTION OF TRAVEL REVERSES FOR THESE THREE, ON PURPOSE. Where the sweep
-- used to push players.membership_type into Discord, the app now follows what
-- the member picked: the sweep READS the role and posts it to
-- /api/discord/membership, which writes membership_type and an audit row naming
-- Discord as the source.
--
-- WHAT THAT COSTS, WRITTEN DOWN HERE BECAUSE IT IS A POLICY CHANGE AND NOT AN
-- IMPLEMENTATION DETAIL: membership_type prices a tournament entry
-- (quoteEntryFee) and gates which events a member may enter (isMembershipAllowed).
-- Letting members pick it means a member can assert the internal (student) fee
-- tier and student-only eligibility for themselves. The club asked for this; the
-- audit row is what makes it correctable rather than invisible. An exec changing
-- it back in the console holds until the member picks a different role again.
--
-- THIS MIGRATION IS CODE-ORDER-INDEPENDENT. Applied before the bot ships, it
-- only permits a configuration nobody has made yet. Applied after, the bot has
-- already stopped sweeping the three, so nothing is stripped in between.

BEGIN;

-- The role names that are still the sweep's. Kept as a function rather than
-- repeated in two trigger bodies so the two directions of the guard can never
-- disagree about which roles they protect.
CREATE OR REPLACE FUNCTION public.discord_role_is_member_chosen(p_role_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  -- Mirrors MEMBERSHIP_ROLES in apps/bot/src/roles.ts. The two lists are small,
  -- change together, and a mismatch is visible immediately: the picker would
  -- refuse a role the bot no longer sweeps.
  SELECT p_role_name IN ('internal', 'alumni', 'external');
$$;

REVOKE ALL ON FUNCTION public.discord_role_is_member_chosen(text) FROM PUBLIC;

-- ---- 1. MANAGED -> SELF-SERVE ---------------------------------------------
--
-- Unchanged except for the exemption and the message. Restated in full rather
-- than patched because CREATE OR REPLACE FUNCTION drops any attribute it does
-- not name, and this one is SECURITY DEFINER with a pinned search_path.

CREATE OR REPLACE FUNCTION public.discord_self_role_not_managed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_managed text;
BEGIN
  SELECT role_name INTO v_managed
    FROM public.discord_guild_roles
   WHERE guild_id = NEW.guild_id
     AND role_id  = NEW.role_id;

  -- The membership roles are still IN discord_guild_roles — the map is what
  -- tells the bot that role 123 is this guild's @Alumni, which is exactly what
  -- makes the write-back possible — they are simply not swept any more.
  IF v_managed IS NOT NULL AND NOT public.discord_role_is_member_chosen(v_managed) THEN
    RAISE EXCEPTION
      'role % is the sweep-managed "%" role for this guild; a self-serve role must not be one the nightly sweep controls',
      NEW.role_id, v_managed
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

-- ---- 2. SELF-SERVE -> MANAGED ---------------------------------------------
--
-- The other direction, and the exemption has to be the same one: without it,
-- offering @Internal in the picker would make it impossible to ever re-map the
-- role afterwards, and /setup — which adopts roles BY NAME — would start
-- failing on a guild that had configured the picker.

CREATE OR REPLACE FUNCTION public.discord_managed_role_not_self_serve()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.discord_role_is_member_chosen(NEW.role_name)
     AND EXISTS (
       SELECT 1 FROM public.discord_self_roles
        WHERE guild_id = NEW.guild_id AND role_id = NEW.role_id
     ) THEN
    RAISE EXCEPTION
      'role % is a self-serve ping role for this guild; mapping it as "%" would let the nightly sweep strip it from members who chose it',
      NEW.role_id, NEW.role_name
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

-- The triggers themselves are unchanged; both functions keep their names, so
-- 00168's CREATE TRIGGER statements still point at the new bodies. Restated
-- anyway so a database that somehow lost one gets it back.
DROP TRIGGER IF EXISTS discord_self_role_not_managed_trg ON public.discord_self_roles;
CREATE TRIGGER discord_self_role_not_managed_trg
  BEFORE INSERT OR UPDATE ON public.discord_self_roles
  FOR EACH ROW EXECUTE FUNCTION public.discord_self_role_not_managed();

DROP TRIGGER IF EXISTS discord_managed_role_not_self_serve_trg ON public.discord_guild_roles;
CREATE TRIGGER discord_managed_role_not_self_serve_trg
  BEFORE INSERT OR UPDATE ON public.discord_guild_roles
  FOR EACH ROW EXECUTE FUNCTION public.discord_managed_role_not_self_serve();

REVOKE ALL ON FUNCTION public.discord_self_role_not_managed()       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.discord_managed_role_not_self_serve() FROM PUBLIC;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- OWNER STEP — not run by this migration, because the role ids come off
-- Discord and this migration cannot guess them.
--
-- The bot's own command does it for you, once the bot is deployed:
--
--   /rolepicker add role:@Internal label:"SFU student"   emoji:🎓 order:1
--   /rolepicker add role:@Alumni   label:"SFU alumni"    emoji:🎓 order:2
--   /rolepicker add role:@External label:"Not from SFU"  emoji:🏸 order:3
--   /rolepicker post
--
-- By hand instead, if you would rather (guild id and role ids from Discord's
-- Developer Mode right-click -> Copy ID):
--
--   INSERT INTO discord_self_roles (guild_id, role_id, label, emoji, sort_order)
--   VALUES ('<guild id>', '<@Internal role id>', 'SFU student', '🎓', 1)
--   ON CONFLICT (guild_id, role_id) DO UPDATE
--     SET label = EXCLUDED.label, emoji = EXCLUDED.emoji,
--         sort_order = EXCLUDED.sort_order;
--
-- To confirm the narrowing worked, this must SUCCEED:
--
--   INSERT INTO discord_self_roles (guild_id, role_id, label)
--   SELECT guild_id, role_id, 'membership is pickable now'
--     FROM discord_guild_roles WHERE role_name = 'internal' LIMIT 1;
--
-- ...and this must still FAIL, which is the half that matters:
--
--   INSERT INTO discord_self_roles (guild_id, role_id, label)
--   SELECT guild_id, role_id, 'should be rejected'
--     FROM discord_guild_roles WHERE role_name = 'executives' LIMIT 1;
--
-- Undo both test rows afterwards:
--
--   DELETE FROM discord_self_roles
--    WHERE label IN ('membership is pickable now', 'should be rejected');
--
-- WHO HOLDS WHAT TODAY. The sweep put a membership role on every approved
-- linked member before this change, and it will not take them off — it no
-- longer touches them at all unless the member is banned or unlinked. So everybody keeps the role the app gave them,
-- which is the right starting point: their Discord role and their
-- membership_type already agree, and the first thing that moves either is a
-- member clicking a button. Nothing needs backfilling.
-- ============================================================================

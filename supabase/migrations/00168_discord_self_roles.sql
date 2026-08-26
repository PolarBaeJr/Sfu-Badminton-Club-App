-- 00168 — Self-serve ping roles, and the guard that keeps the sweep off them.
--
-- WHY A SEPARATE TABLE AND NOT A FLAG ON discord_guild_roles
--
-- The nine roles in discord_guild_roles are DERIVED. They are computed from the
-- app by desiredRoles() and reconciled every night: hold one you should not and
-- the sweep removes it, lack one you should have and the sweep adds it. That is
-- the entire point of them.
--
-- A ping role is the opposite. It is a member's own choice, the app has no
-- opinion about it, and nothing should ever take it away. Putting the two in one
-- table with a boolean would mean one sweep away from stripping every ping role
-- in the server at 10:50 UTC, because roleDiff() iterates MANAGED_ROLES and
-- removes anything held that is not desired.
--
-- Keeping them in separate tables makes the safety property structural: the
-- sweep only ever looks at MANAGED_ROLES, and a role in this table is by
-- definition not one of those. roles.ts documents the same thing from the other
-- side — "a role the map does not name is invisible to the diff".

-- ---- 1. THE ROLES ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.discord_self_roles (
  guild_id    text NOT NULL
              REFERENCES public.discord_guilds(guild_id) ON DELETE CASCADE,
  -- The Discord role id. text for the same reason every other snowflake here is
  -- text: they exceed 2^53 and arrive from Discord as strings.
  role_id     text NOT NULL,
  -- What the button says. Not read back from Discord on purpose: a server can
  -- call the role "pingme-comp" and still show members "Competitive nights".
  label       text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  -- Unicode emoji or a custom emoji in name:id form. Optional.
  emoji       text CHECK (emoji IS NULL OR length(emoji) BETWEEN 1 AND 64),
  -- Discord allows 5 buttons per action row and 5 rows, so 25 is the ceiling
  -- for one picker message. Ordering is explicit rather than by insertion so
  -- the layout is stable across edits.
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, role_id)
);

-- ---- 2. THE GUARD ---------------------------------------------------------
--
-- Refuse to make a SWEEP-MANAGED role self-assignable.
--
-- Without this the failure is invisible at the keyboard and obvious only in
-- production: an exec adds @Competitive to the picker because it looks like a
-- reasonable thing to let people pick, members click it, and the nightly sweep
-- strips it from everybody who is not actually competitive in the app. The
-- button appears broken, the sweep looks like it is misbehaving, and neither is
-- wrong — the configuration was.
--
-- Rejected at write time, in the same spirit as 00167's CHECK on role_name.

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

  IF v_managed IS NOT NULL THEN
    RAISE EXCEPTION
      'role % is already the sweep-managed "%" role for this guild; a self-serve role must not be one the nightly sweep controls',
      NEW.role_id, v_managed
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS discord_self_role_not_managed_trg ON public.discord_self_roles;
CREATE TRIGGER discord_self_role_not_managed_trg
  BEFORE INSERT OR UPDATE ON public.discord_self_roles
  FOR EACH ROW EXECUTE FUNCTION public.discord_self_role_not_managed();

-- The guard has to hold in BOTH directions. The trigger above stops a managed
-- role becoming self-serve; this one stops a self-serve role being promoted
-- into the managed map, which would otherwise hand the sweep a role members
-- assigned themselves.
CREATE OR REPLACE FUNCTION public.discord_managed_role_not_self_serve()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
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

DROP TRIGGER IF EXISTS discord_managed_role_not_self_serve_trg ON public.discord_guild_roles;
CREATE TRIGGER discord_managed_role_not_self_serve_trg
  BEFORE INSERT OR UPDATE ON public.discord_guild_roles
  FOR EACH ROW EXECUTE FUNCTION public.discord_managed_role_not_self_serve();

-- ---- 3. GRANTS ------------------------------------------------------------
--
-- Same posture as the rest of the Discord tables: the bot reaches these only
-- through the app's service-role client, never directly, and no browser session
-- has any business reading a guild's role wiring.

ALTER TABLE public.discord_self_roles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.discord_self_roles FROM PUBLIC;
REVOKE ALL ON public.discord_self_roles FROM anon, authenticated;
GRANT  ALL ON public.discord_self_roles TO service_role;

REVOKE ALL ON FUNCTION public.discord_self_role_not_managed()      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.discord_managed_role_not_self_serve() FROM PUBLIC;

-- PostgREST caches the schema and the app reads this table through it. Without
-- this the first read after the migration comes back as an empty list rather
-- than an error, which is the failure mode that has bitten this project before.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- OWNER STEP — not run by this migration.
--
-- Nothing here needs a secret, but the role ids come off Discord's UI, so this
-- is a paste job rather than something the migration can guess.
--
-- The bot's /rolepicker command writes these rows for you. Do it by hand only
-- if you would rather not use the command:
--
--   INSERT INTO discord_self_roles (guild_id, role_id, label, emoji, sort_order)
--   VALUES ('<guild id>', '<role id>', 'Competitive nights', '🏸', 1)
--   ON CONFLICT (guild_id, role_id) DO UPDATE
--     SET label = EXCLUDED.label,
--         emoji = EXCLUDED.emoji,
--         sort_order = EXCLUDED.sort_order;
--
-- Where the session ping goes. Both live in discord_settings, which already
-- exists from 00167, so no new table is needed for them:
--
--   INSERT INTO discord_settings (key, value)
--   VALUES ('session_ping_channel_id', '<channel id>')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
--
-- To see the wiring:
--
--   SELECT s.guild_id, s.role_id, s.label, s.emoji, s.sort_order
--     FROM discord_self_roles s ORDER BY s.guild_id, s.sort_order, s.label;
--
-- To confirm the guard works, this must FAIL:
--
--   INSERT INTO discord_self_roles (guild_id, role_id, label)
--   SELECT guild_id, role_id, 'should be rejected'
--     FROM discord_guild_roles LIMIT 1;
-- ============================================================================

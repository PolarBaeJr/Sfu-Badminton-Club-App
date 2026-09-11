-- 00229_discord_server_role_catalog.sql
--
-- EVERY MENTIONABLE ROLE IN THE SERVER, so the console's notify picker can offer
-- more than the nine roles the app manages.
--
-- WHY A SECOND TABLE AND NOT A WIDER CHECK ON discord_guild_roles
--
-- The obvious move is to drop `discord_guild_roles_role_name_check` and let any
-- name in. Three separate paths read "a row in discord_guild_roles" as "a role
-- this app MANAGES", and each of them breaks on an arbitrary row:
--
--   1. registryFromPayload (apps/bot/src/config.ts) THROWS on a name outside
--      MANAGED_ROLES, and /api/discord/config puts every role row of an enabled
--      guild into the payload it reads. So one row named `varsity` makes the
--      bot's whole config load throw: the ladder in loadConfig falls back to the
--      last good cache, then to DISCORD_GUILDS, and with neither it throws
--      outright and takes the nightly sweep, the outbox drain and the
--      announcements tick with it. Silent while the cache is warm; total after a
--      restart.
--   2. discord_self_role_not_managed() (00221) looks a role up by
--      (guild_id, role_id) and raises check_violation unless the name is one a
--      member may choose. Any server role stored there becomes permanently
--      un-pickable in /rolepicker add, as an HTTP 409.
--   3. 00167 states the contract in so many words: the CHECK "MUST match
--      MANAGED_ROLES in apps/bot/src/roles.ts exactly".
--
-- 00168 made the same argument about the same class of role, under the heading
-- "WHY A SEPARATE TABLE AND NOT A FLAG ON discord_guild_roles". This is that
-- argument a third time: the nine are DERIVED and reconciled nightly, a role in
-- here is a NAME THE CONSOLE MAY MENTION and nothing else. Keeping them apart
-- makes the safety property structural rather than a convention somebody has to
-- remember.
--
-- WHAT WRITES IT. The bot, on /setup and on the existing five minute
-- announcements tick, through POST /api/discord/server-roles. It is a CATALOGUE,
-- not a mapping: the route replaces a guild's rows outright, because a stale
-- entry here is a picker row pointing at a deleted role, while a stale entry in
-- discord_guild_roles is a mapping that still works and must never be erased.
--
-- WHAT READS IT. The admin console's announcements page, and resolveForDiscord
-- when it turns a picked name into a mention. Deliberately NOT
-- /api/discord/config: adding these rows to that payload re-creates the throw in
-- point 1 above.

CREATE TABLE IF NOT EXISTS public.discord_server_roles (
  -- Same FK and same ON DELETE as 00167's role map: parking a guild by deleting
  -- its row should not leave a catalogue behind naming roles in a server nothing
  -- looks at any more.
  guild_id   text NOT NULL
             REFERENCES public.discord_guilds(guild_id) ON DELETE CASCADE,
  -- The snowflake, checked the same way 00167 checks its role ids. text because
  -- snowflakes exceed 2^53 and arrive from Discord as strings.
  role_id    text NOT NULL CHECK (role_id ~ '^[0-9]{5,25}$'),
  -- AND NO NAME WHITELIST, WHICH IS THE ENTIRE POINT OF THIS TABLE. The CHECK on
  -- discord_guild_roles.role_name is load-bearing and stays exactly as it is:
  -- that column names a role the app assigns, this one names a role somebody in
  -- Discord created. Discord caps a role name at 100 characters, so that is the
  -- only rule there is to enforce here.
  role_name  text NOT NULL CHECK (length(btrim(role_name)) BETWEEN 1 AND 100),
  -- Where Discord draws it. Carried so a picker can be ordered the way the
  -- server lists its roles, and NOT used to decide what is offerable: position
  -- governs who may ASSIGN a role, never who may mention one.
  position   integer,
  synced_at  timestamptz NOT NULL DEFAULT now(),
  -- KEYED ON THE ID, NOT THE NAME. Two roles in one server may share a name, and
  -- the id is what a mention is keyed on, so a (guild_id, role_name) key would
  -- refuse a catalogue that Discord itself accepts.
  PRIMARY KEY (guild_id, role_id),
  -- @everyone shares the guild's own id, and it cannot be notified through the
  -- roles list at all: only allowed_mentions parse: ["everyone"] rings it, and
  -- the console's ping line sends parse: []. Offering it would draw a chip that
  -- rings nobody. The bot filters it out; this is the backstop for the day a
  -- future caller forgets to.
  CONSTRAINT discord_server_roles_not_everyone CHECK (role_id <> guild_id)
);

COMMENT ON TABLE public.discord_server_roles IS
  'Catalogue of the guild''s mentionable roles, synced FROM Discord by the bot. '
  'Read by the console''s notify picker. NOT the roles the app manages: those are '
  'in discord_guild_roles, whose role_name CHECK must keep matching MANAGED_ROLES.';

COMMENT ON COLUMN public.discord_server_roles.role_name IS
  'Whatever Discord calls it. Deliberately unconstrained beyond a length cap, '
  'unlike discord_guild_roles.role_name, which is whitelisted because the bot '
  'throws on a name it does not manage.';

COMMENT ON COLUMN public.discord_server_roles.position IS
  'Discord''s own ordering. Never a filter: hierarchy decides who can assign a '
  'role, not who can mention one.';

-- Same posture as 00167 and 00168. Nothing here is secret -- every member of the
-- server sees a role id in the source of any message mentioning one -- but the
-- console and the bot both reach it through the service role, and a table anon
-- can read is a table anon can be confused into reading somewhere it should not.

ALTER TABLE public.discord_server_roles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.discord_server_roles FROM PUBLIC;
REVOKE ALL ON public.discord_server_roles FROM anon, authenticated;
GRANT ALL  ON public.discord_server_roles TO service_role;

-- PostgREST caches the schema. Without this the new table reads as "relation
-- does not exist" through the API while psql sees it perfectly, and a failed
-- PostgREST read arrives as an EMPTY LIST rather than an error: the picker would
-- simply offer the nine and nothing anywhere would say why.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- AFTER THE MIGRATION
--
-- Nothing to fill in by hand. The bot posts the catalogue on its next
-- announcements tick (five minutes) and on the next /setup. Until then the
-- picker offers exactly the nine it offers today, which is the safe
-- intermediate state.
--
-- To see what the console will offer:
--
--   SELECT guild_id, role_name, position, synced_at
--     FROM discord_server_roles
--    ORDER BY position DESC;
-- ============================================================================

-- 00227_a_console_message_may_carry_buttons.sql
--
-- A CONSOLE MESSAGE MAY NOW CARRY THE MEMBER BUTTONS.
--
-- /guidepost puts one public message in a channel whose three buttons open the
-- flows a new member needs: connect my account, report a bug, send feedback. The
-- club's guide messages were written in the console instead, through the Discord
-- message tab, and arrived without them, because the outbox row had no way to
-- say "and the buttons".
--
-- A NAME, NEVER A PAYLOAD. This column holds the NAME of a button set and the
-- allowlist is one word long. It is deliberately not component JSON: the insert
-- path is a server action, every exported parameter of one is a client
-- controlled POST field, and a column holding raw JSON on that path would be a
-- way to make the club's bot post an arbitrary Discord payload. The buttons
-- themselves stay in apps/bot/src/commands.ts beside guideComponents(), next to
-- the handlers that answer them, so a button that exists is a button something
-- responds to.
--
-- WHY THE BUTTONS ARE SAFE IN A PUBLIC MESSAGE, which is the whole reason this
-- can exist at all: they are custom_id buttons, not URL buttons. /link's URL
-- button carries a token minted per invocation and is a single use credential,
-- which is why that reply is ephemeral. A custom_id button mints nothing until
-- the person who clicks it clicks it, and answers them privately.
--
-- NULL MEANS NO BUTTONS, and that is every row written before today.

BEGIN;

ALTER TABLE public.discord_outbox
  ADD COLUMN IF NOT EXISTS button_set text;

-- Re-stated rather than assumed, so the migration is safe to re-run.
ALTER TABLE public.discord_outbox
  DROP CONSTRAINT IF EXISTS discord_outbox_known_button_set;

ALTER TABLE public.discord_outbox
  ADD CONSTRAINT discord_outbox_known_button_set CHECK (
    button_set IS NULL OR button_set IN ('guide')
  );

COMMENT ON COLUMN public.discord_outbox.button_set IS
  'The NAME of a button set the bot knows, or NULL for no buttons. Never '
  'component JSON: see 00227. Resolved by componentsForButtonSet() in '
  'apps/bot/src/commands.ts. The console''s copy of the allowlist is '
  'DISCORD_BUTTON_SETS in packages/shared/src/utils/discord-buttons.ts.';

COMMIT;

-- WITHOUT THIS THE FEATURE IS DEAD ON ARRIVAL IN BOTH DIRECTIONS. PostgREST
-- caches the schema: the console's insert would be refused against the
-- definition it already knows, and the bot's claim SELECT names button_set, so
-- an unreloaded cache fails the WHOLE select and stops plain messages draining
-- too. Superuser psql proves nothing here, it bypasses the cache entirely.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- NOTHING ELSE IS OWNER-RUN.
--
-- No grants: discord_outbox is GRANT ALL to service_role at TABLE level (00222),
-- which covers a column added later. No column level grants exist on this table,
-- so there is nothing for the nightly staging snapshot to strip.
--
-- To confirm it is reachable THROUGH POSTGREST rather than only through psql:
--
--   select count(*) from discord_outbox where button_set is null;  -- psql
--
-- ...and then queue one message from the console with the buttons switch on. If
-- the row appears in the recent list, PostgREST has the column.
-- ============================================================================

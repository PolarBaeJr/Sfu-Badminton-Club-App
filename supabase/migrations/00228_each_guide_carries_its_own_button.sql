-- 00228_each_guide_carries_its_own_button.sql
--
-- EACH GUIDE MESSAGE CARRIES ONLY THE BUTTON IT IS ABOUT.
--
-- 00227 gave a console message ONE button set, `guide`, which is the whole row
-- /guidepost posts: connect my account, report a bug, send feedback. The club's
-- guide messages were then written in the console and every one of them got all
-- three, even though each message is about a single task. The message explaining
-- how to connect an account should carry the connect button and nothing else.
--
-- STILL A NAME, NEVER A PAYLOAD. This widens the allowlist from one word to
-- four and changes nothing else. The column holds the NAME of a button set and
-- is deliberately not component JSON: the insert path is a server action, every
-- exported parameter of one is a client controlled POST field, and a column
-- holding raw JSON on that path would be a way to make the club's bot post an
-- arbitrary Discord payload.
--
-- THE THREE NEW NAMES ARE SUBSETS OF THE OLD ONE, which is why they cost the bot
-- no new handler and this migration no new grant. `link`, `bug` and `feedback`
-- each resolve to ONE BUTTON OF THE SAME ROW, with the same label, the same
-- style and the same custom_id, so a click on a one-button message is answered by
-- the handler that has answered guide:link since 00227. The resolution is
-- componentsForButtonSet() in apps/bot/src/commands.ts, and the console's copy of
-- the allowlist is DISCORD_BUTTON_SETS in
-- packages/shared/src/utils/discord-buttons.ts.
--
-- WIDENING A CHECK CANNOT BREAK AN EXISTING ROW OR AN EXISTING INSERT, so this
-- is safe to run on its own, ahead of the code, with the current images live.
-- RUN IT FIRST, ALONE: if the admin image ships before this, the app guard
-- accepts `link` and the INSERT then hits 00227's narrower CHECK, and an exec
-- reads a raw Postgres constraint string, which is precisely what the app guard
-- exists to prevent. In the other direction there is nothing to order: a bot
-- image that has not learned `link` resolves it to no components, so the row
-- posts its words without buttons rather than failing.
--
-- NULL STILL MEANS NO BUTTONS, and that is every row written before 00227.

BEGIN;

-- Re-stated rather than assumed, so the migration is safe to re-run.
ALTER TABLE public.discord_outbox
  DROP CONSTRAINT IF EXISTS discord_outbox_known_button_set;

ALTER TABLE public.discord_outbox
  ADD CONSTRAINT discord_outbox_known_button_set CHECK (
    button_set IS NULL OR button_set IN ('guide', 'link', 'bug', 'feedback')
  );

-- Re-stated for the same reason, and because 00227's version of it describes a
-- one word allowlist that is no longer the truth.
COMMENT ON COLUMN public.discord_outbox.button_set IS
  'The NAME of a button set the bot knows, or NULL for no buttons. One of '
  'guide, link, bug, feedback: see 00228. Never component JSON. `guide` is the '
  'whole /guidepost row and the other three are one button of it each, with the '
  'same custom_ids. Resolved by componentsForButtonSet() in '
  'apps/bot/src/commands.ts. The console''s copy of the allowlist is '
  'DISCORD_BUTTON_SETS in packages/shared/src/utils/discord-buttons.ts.';

COMMIT;

-- CHEAP INSURANCE HERE, NOT THE THING THAT MAKES THIS WORK, which is the
-- opposite of 00227 and worth saying plainly. That migration ADDED the column,
-- so without a reload PostgREST refused the insert against the definition it
-- already knew and the bot's claim SELECT failed whole. This one adds no column
-- and changes no signature: a CHECK is enforced by Postgres at INSERT time and
-- is not something PostgREST caches. So this costs nothing and is here only
-- because a schema change with no NOTIFY is the habit worth not forming.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- NOTHING ELSE IS OWNER-RUN.
--
-- No grants: discord_outbox is GRANT ALL to service_role at TABLE level (00222),
-- and this migration adds no column and no function. No column level grants
-- exist on this table, so there is nothing for the nightly staging snapshot to
-- strip.
--
-- To confirm the wider allowlist is live:
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'discord_outbox_known_button_set';
--
-- ...and then edit one real guide message from the console, pick its own single
-- button, and LOOK AT THE CHANNEL. Nothing in this repo proves Discord's PATCH
-- replaces an existing component row rather than leaving it standing: the bot's
-- refusal fallback retries with `components` omitted, and an omitted key leaves
-- the old three buttons in place, so a swap Discord refused would look like a
-- silent no-op. Swap exactly one message before doing the rest.
-- ============================================================================

-- 00226_a_ping_line_above_an_embed.sql
--
-- A CONSOLE MESSAGE MAY NOW BE A PING LINE AND AN EMBED AT ONCE.
--
-- 00222 said one shape or the other, and that was right for what it built: a
-- plain message is /say, an embed is a notice. What it did not anticipate is the
-- Discord message that is both, which is the only way to post a notice that also
-- rings a role: `content` renders ABOVE the embed and is the only field Discord
-- will notify from. A mention inside an embed body never notifies anybody, no
-- matter what allowed_mentions says.
--
-- WHAT IS STILL REFUSED, and it is most of what the old constraint refused:
-- a row with neither shape, a blank string standing in for a value, and an
-- embed body or colour with no headline to attach them to.
--
-- No new column. The ping line is `content`, already holding `<@&id>` because
-- the console resolves role names before it inserts, and the bot derives the
-- notify list from that same text, so the words and the ping cannot disagree.

BEGIN;

ALTER TABLE public.discord_outbox
  DROP CONSTRAINT IF EXISTS discord_outbox_one_shape;

ALTER TABLE public.discord_outbox
  ADD CONSTRAINT discord_outbox_one_shape CHECK (
    -- Present means non-blank. NULL is how "absent" is spelled.
    (content IS NULL OR length(btrim(content)) > 0)
    AND (embed_title IS NULL OR length(btrim(embed_title)) > 0)
    -- No orphan embed parts.
    AND (embed_title IS NOT NULL OR (embed_body IS NULL AND embed_type IS NULL))
    -- And never nothing at all.
    AND (content IS NOT NULL OR embed_title IS NOT NULL)
  );

COMMIT;

-- The constraint changed on a table PostgREST has cached. Without this the
-- console's inserts keep failing against the definition it already knows.
NOTIFY pgrst, 'reload schema';

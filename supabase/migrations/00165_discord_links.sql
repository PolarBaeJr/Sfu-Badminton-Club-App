-- ============================================================
-- 00165 — one Discord account, one badminton account
--
-- Two tables and one function, which together are the whole of the /link flow:
-- the bot mints a short-lived token, the member follows it into the app and
-- signs in with the auth the club already uses, and the app exchanges the token
-- for a link row. The bot never sees a password and never becomes an identity
-- provider. See docs/design/discord-bot.md §4.
--
-- ---- WHY A TABLE AND NOT A COLUMN ON players ----
--
-- The obvious shape is players.discord_user_id, and it is the wrong one here.
-- What stops a member editing their own privileged fields is
-- guard_player_privileged_columns, a BEFORE trigger whose column list is
-- EXPLICIT — 00164 exists solely because elo_review had to be added to it by
-- name. A new column that nobody remembers to add is therefore not protected by
-- default, it is unprotected by default, and this particular column is one a
-- member would very much like to write: pointing discord_user_id at their own
-- Discord account on somebody else's row hands them that person's roles.
--
-- A separate table sidesteps the guard entirely. It carries no grants to
-- anon or authenticated at all, so there is no member-facing write to guard.
--
-- ---- THE GRANTS ARE THE CONTROL, NOT THE POLICIES ----
--
-- RLS is enabled on both tables with ZERO policies, which denies every row —
-- but that is the second lock, not the first. Supabase's default privileges
-- grant anon/authenticated on new tables in public, and an UNQUALIFIED UPDATE
-- NEEDS NO SELECT GRANT: the elo_review review on 2026-08-23 turned on exactly
-- that mistake. So both tables REVOKE ALL from PUBLIC and from anon,
-- authenticated, following 00159's club_ledger, and service_role is the only
-- role that can reach them.
--
-- Verify the result with pg_class.relacl or SET ROLE. Do NOT verify it with
-- information_schema.role_table_grants — it reports grants that do not exist.
--
-- ---- INTERACTION WITH merge_players (00163) ----
--
-- player_discord_links.player_id is the primary key and cascades on delete, so
-- it lands in 00163's "class 2": unique per player, and the loser's row goes
-- away with the merge rather than moving. If BOTH accounts were linked that is
-- correct — the survivor keeps their own link. If only the LOSER was linked,
-- the merged member ends up unlinked, the next sweep removes their Discord
-- roles, and they have to run /link again.
--
-- That is deliberate and it is left as-is: /link is thirty seconds of
-- self-service, the outcome is visible rather than silent (the roles disappear),
-- and repointing the link would mean re-issuing the whole of merge_players'
-- body to add three lines. If the club would rather it moved, the three lines
-- are the same class-2 shape as session_rsvp's and belong in a later migration.
--
-- SAFE TO APPLY AT ANY TIME. Two new tables nothing reads yet, one new
-- function, no changes to any existing object.
-- ============================================================

BEGIN;

-- ---- 1. THE LINK ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.player_discord_links (
  -- PRIMARY KEY, not merely a foreign key: this is what makes it one app
  -- account to one Discord account in the first direction.
  player_id         uuid PRIMARY KEY
                    REFERENCES public.players(id) ON DELETE CASCADE,
  -- UNIQUE gives the second direction. Together they close proxy registration
  -- through a second Discord identity.
  --
  -- text, not bigint: Discord snowflakes exceed 2^53 and every Discord API
  -- payload carries them as strings. Storing them as a number is how they
  -- arrive back subtly wrong.
  discord_user_id   text NOT NULL UNIQUE,
  linked_at         timestamptz NOT NULL DEFAULT now(),
  -- Written by the reconciliation sweep. Null means "never synced", which is
  -- what a freshly linked member looks like until the first sync runs.
  last_synced_at    timestamptz
);

-- ---- 2. THE ONE-TIME TOKEN ------------------------------------------------

CREATE TABLE IF NOT EXISTS public.discord_link_tokens (
  -- The HASH, never the token. The token itself travels in a URL the member
  -- clicks, which means it passes through Discord, their browser history and
  -- any link preview in between; storing only the hash means a leaked dump
  -- cannot be replayed into a link.
  token_hash        text PRIMARY KEY,
  discord_user_id   text NOT NULL,
  -- Recorded for the audit trail only. Never trusted for anything: the guild a
  -- request came from does not decide what the member gets.
  guild_id          text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  consumed_by       uuid REFERENCES public.players(id) ON DELETE SET NULL
);

-- Consumed and expired rows are the sweepable ones; this is the index that
-- makes the cleanup delete cheap rather than a table scan every few minutes.
CREATE INDEX IF NOT EXISTS idx_discord_link_tokens_expires_at
  ON public.discord_link_tokens (expires_at);

-- ---- 3. LOCK BOTH TABLES --------------------------------------------------

ALTER TABLE public.player_discord_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_link_tokens  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.player_discord_links FROM PUBLIC;
REVOKE ALL ON public.player_discord_links FROM anon, authenticated;
GRANT ALL  ON public.player_discord_links TO service_role;

REVOKE ALL ON public.discord_link_tokens FROM PUBLIC;
REVOKE ALL ON public.discord_link_tokens FROM anon, authenticated;
GRANT ALL  ON public.discord_link_tokens TO service_role;

-- ---- 4. THE EXCHANGE ------------------------------------------------------

-- SECURITY DEFINER because the member is the one calling it and the member has
-- no grant on either table — which is the point. The function is the ONLY way
-- an authenticated session can write a link, and it decides which player row
-- gets linked from auth.uid() rather than from anything the caller passes.
--
-- The only argument is the token hash. There is deliberately no player_id
-- parameter: an argument the caller controls would be an argument the caller
-- can point at somebody else.
-- The return type changed while this migration was being written, and
-- CREATE OR REPLACE cannot change a return type, so the DROP is what keeps the
-- file re-runnable rather than failing on the second attempt with 42P13.
DROP FUNCTION IF EXISTS public.consume_discord_link_token(text);

CREATE FUNCTION public.consume_discord_link_token(p_token_hash text)
-- BOTH accounts come back, because linking is sometimes a MOVE. A member who
-- re-links from a new Discord account leaves the old one sitting in the guild
-- still holding every role it was granted — an @Executives that now belongs to
-- an account the club no longer recognises. The caller needs the displaced id
-- to strip it, and only this function is in a position to know it.
RETURNS TABLE (linked_discord_user_id text, displaced_discord_user_id text)
LANGUAGE plpgsql
SECURITY DEFINER
-- Bare 'public', matching guard_player_privileged_columns: auth.uid() is
-- schema-qualified at each use below, so auth does not need to be on the path.
SET search_path TO 'public'
AS $function$
DECLARE
  v_player_id uuid;
  v_discord   text;
  v_owner     uuid;
  v_previous  text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  SELECT id INTO v_player_id FROM players WHERE user_id = auth.uid();
  IF v_player_id IS NULL THEN
    RAISE EXCEPTION 'No player record for this account';
  END IF;

  -- Claim and validate in ONE statement. Checking first and updating after
  -- would let two concurrent redemptions of the same token both pass the check;
  -- the UPDATE's own WHERE clause is what makes single-use actually single-use,
  -- because only one of them can match consumed_at IS NULL.
  UPDATE discord_link_tokens t
     SET consumed_at = now(),
         consumed_by = v_player_id
   WHERE t.token_hash = p_token_hash
     AND t.consumed_at IS NULL
     AND t.expires_at > now()
  RETURNING t.discord_user_id INTO v_discord;

  IF v_discord IS NULL THEN
    -- One message for expired, already-used and never-existed alike. Telling
    -- them apart would confirm to a guesser that a token string was real.
    RAISE EXCEPTION 'That link has expired or has already been used. Run /link again.';
  END IF;

  -- Is this Discord account already spoken for by somebody else? The UNIQUE
  -- constraint would catch it, but as a 23505 the app can only report as
  -- "something went wrong". Checked explicitly so the member gets told what is
  -- actually true.
  SELECT player_id INTO v_owner
    FROM player_discord_links WHERE discord_user_id = v_discord;

  IF v_owner IS NOT NULL AND v_owner <> v_player_id THEN
    RAISE EXCEPTION 'That Discord account is already linked to a different member.';
  END IF;

  -- Read the outgoing account BEFORE the upsert overwrites it.
  SELECT l.discord_user_id INTO v_previous
    FROM player_discord_links l WHERE l.player_id = v_player_id;

  -- Re-linking your own account is allowed and is how somebody moves to a new
  -- Discord account: the row is replaced, and last_synced_at resets to null so
  -- the next sweep treats it as never synced.
  INSERT INTO player_discord_links (player_id, discord_user_id, linked_at, last_synced_at)
  VALUES (v_player_id, v_discord, now(), NULL)
  ON CONFLICT (player_id) DO UPDATE
    SET discord_user_id = EXCLUDED.discord_user_id,
        linked_at       = now(),
        last_synced_at  = NULL;

  -- Null when this is a first link, and null when they redeemed a token for the
  -- account they already had: in both cases there is nothing to strip.
  RETURN QUERY SELECT v_discord, NULLIF(v_previous, v_discord);
END
$function$;

REVOKE ALL ON FUNCTION public.consume_discord_link_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_discord_link_token(text) TO authenticated;

COMMIT;

-- Without this the new tables and the function are invisible to PostgREST until
-- something else happens to reload the cache, and every read returns an EMPTY
-- LIST rather than an error. Superuser psql would not show it: it bypasses both
-- the schema cache and the grants.
NOTIFY pgrst, 'reload schema';

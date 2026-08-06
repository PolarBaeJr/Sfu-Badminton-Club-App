-- ============================================================
-- 00066 — one player row per email address
--
-- players.email had no uniqueness at all (players_pkey and
-- players_user_id_key were the only unique indexes), while the
-- onboarding claim path in apps/player/src/lib/actions/profile.ts
-- looks a member up BY email with .maybeSingle(). Two unclaimed
-- rows sharing an address therefore do not produce a duplicate
-- to tidy up later — they throw on every attempt and block that
-- person's onboarding permanently, with no self-service way out.
--
-- Two parts, because the index alone is not enough: 'LSA139@sfu.ca'
-- and 'lsa139@sfu.ca' are different strings but the same mailbox,
-- and admin-entered roster rows are typed by hand. Normalising on
-- write also makes the claim lookup an exact .eq() match, which
-- is how the ilike-wildcard hole in that same lookup gets closed
-- (`_` and `%` are legal in a local part and are wildcards to
-- ilike, so 'a_c@sfu.ca' matched the unclaimed row for
-- 'abc@sfu.ca').
--
-- Checked against production before writing: 7 player rows, no
-- two sharing a lowercased address, so the index builds cleanly.
--
-- Safe against the deletion flow: purge-deleted-accounts sets
-- email = 'deleted+<player uuid>@deleted.invalid', which is
-- unique per row by construction.
-- ============================================================

-- ---- 1. Normalise what is already stored -------------------
-- Runs before the trigger exists so it is a plain data fix; after this the
-- trigger keeps the invariant rather than establishing it.
UPDATE players
   SET email = lower(btrim(email))
 WHERE email IS DISTINCT FROM lower(btrim(email));

-- ---- 2. Keep it normalised ---------------------------------
-- BEFORE, so the stored value is already folded by the time the unique index
-- and every other trigger see it. Chosen over a generated column because
-- 00032 hands out column-level SELECT grants on this table; a new column would
-- need its own grant decision, and there is nothing to gain from storing the
-- same address twice.
CREATE OR REPLACE FUNCTION normalize_player_email()
RETURNS TRIGGER AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION normalize_player_email() IS
  'Folds players.email to lower(btrim(...)) on write so the address is a stable identity key: the unique index below cannot be dodged by capitalisation, and the onboarding claim lookup can match with .eq() instead of a wildcard-bearing ilike pattern.';

DROP TRIGGER IF EXISTS normalize_player_email_trg ON players;
CREATE TRIGGER normalize_player_email_trg
  BEFORE INSERT OR UPDATE OF email ON players
  FOR EACH ROW EXECUTE FUNCTION normalize_player_email();

-- ---- 3. State the invariant --------------------------------
-- On lower(email) rather than on email, so it still holds if the trigger is
-- ever dropped or a future migration writes around it.
CREATE UNIQUE INDEX IF NOT EXISTS players_email_lower_key
  ON players (lower(email));

COMMENT ON INDEX players_email_lower_key IS
  'One player row per email address. Without it, two unclaimed rows sharing an address made the onboarding claim lookup .maybeSingle() throw and blocked that user permanently.';

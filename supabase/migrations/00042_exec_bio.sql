-- ============================================================
-- 00042_exec_bio.sql — bio and a dedicated photo on the public exec page
-- ============================================================
-- ⚠️ MUST BE APPLIED AFTER 00040. The privileged-column guard below is
-- redefined wholesale and references NEW.membership_type, which 00040 adds.
-- plpgsql resolves that at RUNTIME, so applying this first does not fail here —
-- it fails on the next UPDATE to any player row. Run them in order.
-- ============================================================
-- players.bio has existed since 00001 and members have been able to edit it in
-- Settings the whole time. get_executives() just never returned it, so the exec
-- page showed a name, an avatar and a title, and whatever an exec wrote about
-- themselves went nowhere.
--
-- exec_photo_url is a SEPARATE column from avatar_url on purpose. The exec page
-- gets proper posed photos, and an exec's ladder avatar is a different thing
-- serving a different purpose — reusing avatar_url would mean changing your
-- profile picture silently changes the club's public-facing page, and stepping
-- down from exec would leave the page pointed at a personal photo.
--
-- SECURITY NOTE: this makes bio and exec_photo_url PUBLIC for execs —
-- get_executives() is granted to anon so the page works logged-out. Neither
-- leaks for anyone else: 00032 revoked blanket SELECT on players, and this
-- function is SECURITY DEFINER filtered to is_exec = TRUE. The settings screen
-- tells execs their bio is publicly visible, because silently publishing text
-- someone wrote under different assumptions is not something a migration
-- should do quietly.
-- ============================================================

ALTER TABLE players ADD COLUMN IF NOT EXISTS exec_photo_url TEXT;

COMMENT ON COLUMN players.exec_photo_url IS
  'Photo shown on the public /exec page. Deliberately separate from avatar_url so a profile-picture change does not alter the club page, and stepping down from exec does not leave a personal photo published.';

-- Admin-set, like exec_title and is_exec. A member must not be able to publish
-- an arbitrary image onto the club''s public page from their own profile
-- update, so this joins the privileged-column guard.
CREATE OR REPLACE FUNCTION guard_player_privileged_columns()
RETURNS TRIGGER AS $$
BEGIN
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
     -- Carried from 00040. This function is redefined wholesale, so omitting a
     -- column silently DROPS its protection — and 00040 lives on a different
     -- branch, so the two changes only meet here. Leaving membership_type out
     -- would have let a member set themselves to 'internal' with a plain
     -- profile update and walk into an internal-only event.
     OR NEW.membership_type IS DISTINCT FROM OLD.membership_type
     -- New in 00042: publishing an image to the public exec page is an admin
     -- action, not a self-service profile edit.
     OR NEW.exec_photo_url IS DISTINCT FROM OLD.exec_photo_url THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS get_executives();

CREATE OR REPLACE FUNCTION get_executives()
RETURNS TABLE(id uuid, name text, exec_title text, exec_photo_url text, bio text) AS $$
  SELECT id, COALESCE(display_name, full_name) AS name, exec_title, exec_photo_url, bio
  FROM players
  WHERE is_exec = TRUE AND active_flag = TRUE
  ORDER BY (exec_title IS NULL), exec_title, COALESCE(display_name, full_name);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION get_executives() TO anon, authenticated;

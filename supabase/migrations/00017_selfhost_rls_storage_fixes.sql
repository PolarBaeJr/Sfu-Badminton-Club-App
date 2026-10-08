-- ============================================================
-- 00017 — Self-host RLS / storage fixes (beta bug batch)
-- ============================================================
-- Fixes found during beta testing on the self-hosted stack:
--   #2  Players cannot confirm match results — apply_match_result /
--       reverse_match_result run as the caller and their final
--       INSERT INTO audit_logs fails audit_insert RLS (admin-only),
--       rolling back the whole confirmation. Make them SECURITY DEFINER
--       (mirrors increment_challenges_issued, which already is).
--   #3  Profile-picture upload returns "Bucket not found" — the
--       `avatars` storage bucket was never created on self-hosted
--       Supabase. Create it (public read) + owner-scoped write policies.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- #2  Privileged match functions -> SECURITY DEFINER
-- ------------------------------------------------------------
-- ALTER (not CREATE OR REPLACE) so the canonical bodies in
-- 00003_functions.sql stay the single source of truth; only the
-- security context changes. search_path is pinned to avoid definer
-- search-path hijacking.
ALTER FUNCTION public.apply_match_result(uuid, uuid)
  SECURITY DEFINER
  SET search_path = public, pg_temp;

ALTER FUNCTION public.reverse_match_result(uuid)
  SECURITY DEFINER
  SET search_path = public, pg_temp;

-- ------------------------------------------------------------
-- #3  avatars storage bucket + object policies
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', TRUE)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- Public read (bucket is public; explicit SELECT policy keeps signed +
-- listing paths working too).
DROP POLICY IF EXISTS "avatars_public_read" ON storage.objects;
CREATE POLICY "avatars_public_read" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'avatars');

-- Any authenticated user may upload / overwrite / remove objects in the
-- avatars bucket. Path convention is "<playerId>.<ext>"; the app already
-- restricts a user to their own playerId, and avatars are non-sensitive
-- public images, so per-object owner scoping is not enforced here.
DROP POLICY IF EXISTS "avatars_auth_insert" ON storage.objects;
CREATE POLICY "avatars_auth_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars');

DROP POLICY IF EXISTS "avatars_auth_update" ON storage.objects;
CREATE POLICY "avatars_auth_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars')
  WITH CHECK (bucket_id = 'avatars');

DROP POLICY IF EXISTS "avatars_auth_delete" ON storage.objects;
CREATE POLICY "avatars_auth_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'avatars');

-- In-app bug reports with a screenshot.
--
-- 00172 built feedback_reports for the Discord /bug and /feedback commands and
-- left `source` open to 'app'. This adds the two things the in-app form needs:
-- somewhere to put the screenshot, and a column to remember where it went.

-- ---------------------------------------------------------------------------
-- 1. The bucket. PRIVATE, deliberately.
-- ---------------------------------------------------------------------------
--
-- `avatars` is public because an avatar is already shown to every member. A bug
-- screenshot is not: it is whatever was on the reporter's screen when something
-- went wrong, which routinely means their own profile, their fees, or someone
-- else's name. 00172 revoked anon/authenticated on feedback_reports precisely so
-- reports stay staff-only, and a public bucket would put the most revealing part
-- of the report back outside that boundary. An unguessable path is not an access
-- control.
--
-- Size cap matches MAX_IMAGE_BYTES in apps/bot/src/feedback.ts. Setting it here
-- means an oversized file is refused AT UPLOAD, where the reporter is still
-- present to see the error, instead of being accepted and then silently dropped
-- by the bot at relay time an hour later.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'feedback-screenshots',
  'feedback-screenshots',
  FALSE,
  8388608,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2. Storage policies: write-only, and only into your own folder.
-- ---------------------------------------------------------------------------
--
-- INSERT only. There is deliberately no SELECT policy for authenticated: a
-- reporter never needs to read a screenshot back (the form previews the local
-- File it is about to upload, the same trick AvatarUpload uses), and without
-- SELECT nobody can enumerate or fetch anyone else's. The relay reads these with
-- the service role, which bypasses RLS.
--
-- The folder is auth.uid(), NOT players.id — players.id is a separate uuid and
-- storage RLS can only see the JWT subject. foldername()[1] is the first path
-- segment.
DROP POLICY IF EXISTS "own folder insert" ON storage.objects;
CREATE POLICY "own folder insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'feedback-screenshots'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- 3. Remember the PATH, never a URL.
-- ---------------------------------------------------------------------------
--
-- image_url holds a Discord CDN link for Discord-sourced reports, and those are
-- signed and expire — the bot copes by fetching promptly and treating NULL as
-- ordinary. We do NOT want to inherit that for our own uploads: a signed URL
-- stored in a row rots, and the admin triage page 00172 defers to a later
-- migration would find every older screenshot dead. Storing the path keeps it
-- resolvable forever; the relay signs a short-lived URL at the moment it posts.
ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS image_path TEXT;

COMMENT ON COLUMN feedback_reports.image_path IS
  'Object path in the private feedback-screenshots bucket, for source=app. Sign it on demand; never store the signed URL.';

NOTIFY pgrst, 'reload schema';

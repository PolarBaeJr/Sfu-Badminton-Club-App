'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AvatarChip } from '@badminton/ui';
import { createClient } from '@/lib/supabase-browser';
import { useToast } from '@/components/toast-provider';
import { AvatarCropDialog } from '@/components/AvatarCropDialog';

interface AvatarUploadProps {
  playerId: string;
  playerName: string;
  currentUrl?: string | null;
  onUploaded?: (url: string) => void;
}

const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Storage sits behind /supabase on whichever host the app is served from, so
// rewriting the origin keeps avatars same-origin. Two reasons that matters: the
// URL is persisted in players.avatar_url and would otherwise outlive the host it
// names (every avatar written before the domain move still pointed at the old
// one), and the cropper re-reads this image to change the framing — a
// cross-origin image taints the canvas and toBlob() throws.
function publicStorageUrl(
  supabase: ReturnType<typeof createClient>,
  path: string,
): string {
  const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base || typeof window === 'undefined' || !publicUrl.startsWith(base)) return publicUrl;
  return `${window.location.origin}/supabase${publicUrl.slice(base.length)}`;
}

export function AvatarUpload({ playerId, playerName, currentUrl, onUploaded }: AvatarUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(currentUrl);
  // Object URL of the picked file, shown in the crop dialog.
  const [pendingSrc, setPendingSrc] = useState<string | null>(null);
  // The file itself, kept so the uncropped original can be stored alongside the
  // crop. Null when re-framing an existing photo — there is nothing new to keep.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [loadingOriginal, setLoadingOriginal] = useState(false);
  const originalPath = `avatars/${playerId}.original`;
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const router = useRouter();

  // Object URLs must be revoked or the blob stays pinned for the session.
  useEffect(() => {
    return () => { if (pendingSrc?.startsWith('blob:')) URL.revokeObjectURL(pendingSrc); };
  }, [pendingSrc]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so re-picking the same file still fires onChange.
    e.target.value = '';
    if (!file) return;

    if (!ALLOWED_TYPES.includes(file.type)) {
      toast('Please upload a JPG, PNG, or WebP image', 'error');
      return;
    }
    if (file.size > MAX_SIZE) {
      toast('File must be under 5MB', 'error');
      return;
    }
    // Don't upload yet — let the player frame it first.
    setPendingFile(file);
    setPendingSrc(URL.createObjectURL(file));
  }

  // Re-frame the photo already on file. Prefers the uncropped original, so
  // zooming back out can recover what an earlier crop cut off; older avatars
  // predate that and fall back to the cropped square, which can still be
  // re-positioned, just not widened.
  async function handleReframe() {
    setLoadingOriginal(true);
    try {
      const supabase = createClient();
      // Always hand the cropper a blob: URL. It draws the image to a canvas and
      // calls toBlob(), which throws on a canvas tainted by a cross-origin
      // image — fetching first sidesteps that wherever storage is served from.
      const sources = [`${publicStorageUrl(supabase, originalPath)}?t=${Date.now()}`];
      if (avatarUrl) sources.push(avatarUrl);

      let blob: Blob | null = null;
      for (const src of sources) {
        const res = await fetch(src).catch(() => null);
        if (res?.ok) { blob = await res.blob(); break; }
      }
      if (!blob) {
        toast('No photo to reposition yet — upload one first', 'error');
        return;
      }

      setPendingFile(null);
      setPendingSrc(URL.createObjectURL(blob));
    } catch {
      toast('Could not load your photo — try uploading it again', 'error');
    } finally {
      setLoadingOriginal(false);
    }
  }

  function closeCropper() {
    // Object URLs need revoking; a remote https: src must be left alone.
    if (pendingSrc?.startsWith('blob:')) URL.revokeObjectURL(pendingSrc);
    setPendingSrc(null);
    setPendingFile(null);
  }

  async function handleCropped(blob: Blob) {
    setUploading(true);
    try {
      const supabase = createClient();
      // The cropper always re-encodes to JPEG, so the object name is stable at
      // "<playerId>.jpg". That also satisfies the storage RLS policy, which
      // scopes writes by the filename stem (migration 00022).
      const path = `avatars/${playerId}.jpg`;

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });

      if (uploadError) throw uploadError;

      // Keep the uncropped source so the framing can be changed later without
      // making the player find the file again. Stored under "<playerId>.original"
      // — the RLS policy matches on split_part(filename, '.', 1), which is still
      // the player id, so this needs no policy change. Best-effort: a failure
      // here costs re-picking the file later, not the avatar itself.
      if (pendingFile) {
        const { error: origError } = await supabase.storage
          .from('avatars')
          .upload(originalPath, pendingFile, { upsert: true, contentType: pendingFile.type });
        if (origError) console.error('Could not keep the original avatar:', origError.message);
      }

      // Cache buster — the path is stable, so browsers would keep the old image.
      const url = `${publicStorageUrl(supabase, path)}?t=${Date.now()}`;

      const { error: updateError } = await supabase
        .from('players')
        .update({ avatar_url: url })
        .eq('id', playerId);

      if (updateError) throw updateError;

      setAvatarUrl(url);
      onUploaded?.(url);
      closeCropper();
      // Every other avatar on screen — the top bar, the feed, leaderboard rows —
      // is server-rendered from players.avatar_url, so local state alone left
      // them showing the previous photo until a full reload. Re-run the server
      // components so the whole app picks up the new URL at once.
      router.refresh();
      toast('Avatar updated', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Upload failed', 'error');
    }
    setUploading(false);
  }

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Tapping the photo repositions it when there is one — the common case,
          since changing the framing should not mean finding the file again.
          Choosing a different photo is its own action below. */}
      <button
        onClick={() => (avatarUrl ? handleReframe() : fileRef.current?.click())}
        disabled={uploading || loadingOriginal}
        className="relative group cursor-pointer min-h-[56px] min-w-[56px]"
      >
        <AvatarChip name={playerName} src={avatarUrl} size="lg" id={playerId} />
        <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <span className="text-white text-xs font-medium">
            {uploading ? 'Uploading…' : loadingOriginal ? 'Loading…' : avatarUrl ? 'Reposition' : 'Upload'}
          </span>
        </div>
        {(uploading || loadingOriginal) && (
          <div className="absolute inset-0 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
        )}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleFileChange}
      />

      {avatarUrl ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleReframe}
            disabled={uploading || loadingOriginal}
            className="btn btn-ghost text-xs px-3 py-1.5 disabled:opacity-40"
          >
            Reposition
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || loadingOriginal}
            className="btn btn-ghost text-xs px-3 py-1.5 disabled:opacity-40"
          >
            Upload new photo
          </button>
        </div>
      ) : (
        <p className="text-xs text-[var(--text-muted)]">Tap to upload (JPG, PNG, WebP, max 5MB)</p>
      )}

      <AvatarCropDialog
        open={pendingSrc !== null}
        imageSrc={pendingSrc}
        busy={uploading}
        onCancel={closeCropper}
        onConfirm={handleCropped}
      />
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
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

export function AvatarUpload({ playerId, playerName, currentUrl, onUploaded }: AvatarUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(currentUrl);
  // Object URL of the picked file, shown in the crop dialog.
  const [pendingSrc, setPendingSrc] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  // Object URLs must be revoked or the blob stays pinned for the session.
  useEffect(() => {
    return () => { if (pendingSrc) URL.revokeObjectURL(pendingSrc); };
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
    setPendingSrc(URL.createObjectURL(file));
  }

  function closeCropper() {
    if (pendingSrc) URL.revokeObjectURL(pendingSrc);
    setPendingSrc(null);
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

      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);

      // Cache buster — the path is stable, so browsers would keep the old image.
      const url = `${publicUrl}?t=${Date.now()}`;

      const { error: updateError } = await supabase
        .from('players')
        .update({ avatar_url: url })
        .eq('id', playerId);

      if (updateError) throw updateError;

      setAvatarUrl(url);
      onUploaded?.(url);
      closeCropper();
      toast('Avatar updated', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Upload failed', 'error');
    }
    setUploading(false);
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className="relative group cursor-pointer min-h-[56px] min-w-[56px]"
      >
        <AvatarChip name={playerName} src={avatarUrl} size="lg" id={playerId} />
        <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <span className="text-white text-xs font-medium">
            {uploading ? 'Uploading...' : 'Change'}
          </span>
        </div>
        {uploading && (
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
      <p className="text-xs text-[var(--text-muted)]">Tap to upload (JPG, PNG, WebP, max 5MB)</p>

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

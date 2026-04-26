'use client';

import { useState, useRef } from 'react';
import { Avatar } from '@badminton/ui';
import { createClient } from '@/lib/supabase-browser';
import { updateAvatarUrl } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

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
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!ALLOWED_TYPES.includes(file.type)) {
      toast('Please upload a JPG, PNG, or WebP image', 'error');
      return;
    }
    if (file.size > MAX_SIZE) {
      toast('File must be under 5MB', 'error');
      return;
    }

    setUploading(true);
    try {
      const supabase = createClient();
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `avatars/${playerId}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);

      // Add cache buster
      const url = `${publicUrl}?t=${Date.now()}`;

      // Update player via server action — server validates the URL, enforces
      // per-user ownership via session, and refuses arbitrary field writes.
      await updateAvatarUrl(url);

      setAvatarUrl(url);
      onUploaded?.(url);
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
        <Avatar name={playerName} src={avatarUrl} size="lg" />
        <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <span className="text-white text-xs font-medium">
            {uploading ? 'Uploading...' : 'Change'}
          </span>
        </div>
        {uploading && (
          <div className="absolute inset-0 rounded-full border-2 border-[var(--ds-accent)] border-t-transparent animate-spin" />
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
    </div>
  );
}

import React from 'react';

interface AvatarChipProps {
  /** Player full name — initials are derived from this. */
  name: string;
  /** Stable id used to deterministically pick a tone. Falls back to name. */
  id?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  /** Add a red ring (used to mark "you" in lists). */
  ring?: boolean;
  /** Override the auto-tone if needed (1-7). */
  tone?: number;
}

function initials(name: string) {
  return (name || '?')
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}
function toneFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return ((h % 7) + 1);
}

/** The .avatar primitive with deterministic tone. Drops the per-call-site
 * initials/tone helpers we were copy-pasting into ~10 page files. */
export function AvatarChip({ name, id, size = 'sm', ring, tone }: AvatarChipProps) {
  const seed = id ?? name;
  const t = tone ?? toneFor(seed);
  return (
    <span
      className="avatar"
      data-size={size}
      data-tone={t}
      style={ring ? { boxShadow: '0 0 0 2px var(--red)' } : undefined}
    >
      {initials(name)}
    </span>
  );
}

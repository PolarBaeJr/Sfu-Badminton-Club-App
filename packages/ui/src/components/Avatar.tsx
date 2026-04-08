'use client';

import React, { useState } from 'react';
import { cn } from '../utils';

interface AvatarProps {
  name: string;
  src?: string | null;
  size?: 'sm' | 'md' | 'lg';
}

export function Avatar({ name, src, size = 'md' }: AvatarProps) {
  const [errored, setErrored] = useState(false);
  const sizes = { sm: 'w-8 h-8 text-xs', md: 'w-10 h-10 text-sm', lg: 'w-14 h-14 text-lg' };
  const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);

  if (src && !errored) {
    return (
      <img
        src={src}
        alt={name}
        className={cn('rounded-full object-cover', sizes[size])}
        onError={() => setErrored(true)}
      />
    );
  }

  return (
    <div className={cn('rounded-full bg-[var(--color-accent)] flex items-center justify-center text-white font-medium', sizes[size])}>
      {initials}
    </div>
  );
}

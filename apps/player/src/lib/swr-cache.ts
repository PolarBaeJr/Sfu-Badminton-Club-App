'use client';

import type { Cache, State } from 'swr';

const STORAGE_KEY = 'sfu-swr-cache-v1';
const ALLOWED_KEY_PREFIXES = ['/api/leaderboard', '/api/me'];

function isPersistable(key: string): boolean {
  return ALLOWED_KEY_PREFIXES.some((p) => key.startsWith(p));
}

export function localStorageProvider(): Cache {
  if (typeof window === 'undefined') return new Map();

  const map = new Map<string, State<unknown>>();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const entries = JSON.parse(raw) as [string, State<unknown>][];
      for (const [k, v] of entries) {
        if (isPersistable(k)) map.set(k, v);
      }
    }
  } catch {
    // corrupt cache — fall through with empty map
  }

  const persist = () => {
    try {
      const persistable = Array.from(map.entries()).filter(([k]) => isPersistable(k));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
    } catch {
      // quota exceeded — drop silently
    }
  };

  window.addEventListener('beforeunload', persist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persist();
  });

  return map as Cache;
}

'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';

type Counts = { unreadNotifs: number; unreadAnnouncements: number };
type CountsContextValue = Counts & { refresh: () => void };

const Ctx = createContext<CountsContextValue>({
  unreadNotifs: 0,
  unreadAnnouncements: 0,
  refresh: () => {},
});

export function useNotificationCounts() {
  return useContext(Ctx);
}

export function NotificationCountsProvider({
  isAuthed,
  children,
}: {
  isAuthed: boolean;
  children: React.ReactNode;
}) {
  const [counts, setCounts] = useState<Counts>({ unreadNotifs: 0, unreadAnnouncements: 0 });

  const refresh = useCallback(async () => {
    if (!isAuthed) return;
    try {
      const res = await fetch('/api/unread-counts', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as Counts;
      setCounts(data);
    } catch {
      // network error — keep last value
    }
  }, [isAuthed]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    function onFocus() { refresh(); }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return <Ctx.Provider value={{ ...counts, refresh }}>{children}</Ctx.Provider>;
}

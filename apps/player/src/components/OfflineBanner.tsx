'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  const router = useRouter();

  useEffect(() => {
    function handleOffline() {
      setOffline(true);
    }
    function handleOnline() {
      setOffline(false);
      router.refresh();
    }

    setOffline(!navigator.onLine);

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [router]);

  if (!offline) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[100] bg-[var(--color-warning)] text-black text-center text-sm py-2 px-4 font-medium">
      You&apos;re offline — changes will sync when reconnected
    </div>
  );
}

'use client';

import { SWRConfig } from 'swr';
import { localStorageProvider } from '@/lib/swr-cache';

export function SWRProvider({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={{ provider: localStorageProvider, revalidateOnFocus: true }}>
      {children}
    </SWRConfig>
  );
}

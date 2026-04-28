'use client';

import { createContext, useContext } from 'react';
import useSWR from 'swr';

export type Profile = {
  id: string;
  full_name: string;
  avatar_url: string | null;
  status: string | null;
  singles_elo: number | null;
  doubles_elo: number | null;
} | null;

const Ctx = createContext<{ profile: Profile; isLoading: boolean }>({
  profile: null,
  isLoading: false,
});

export function useProfile() {
  return useContext(Ctx);
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function ProfileProvider({
  initial,
  children,
}: {
  initial: Profile;
  children: React.ReactNode;
}) {
  const { data, isLoading } = useSWR<Profile>('/api/me', fetcher, {
    fallbackData: initial,
  });
  return <Ctx.Provider value={{ profile: data ?? null, isLoading }}>{children}</Ctx.Provider>;
}

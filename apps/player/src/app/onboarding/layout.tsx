import { createServerSupabaseClient } from '@/lib/supabase-server';
import { ensurePlayerRowForUser } from '@/lib/first-signin';

// A LAYOUT, NOT THE PAGE, because page.tsx is 'use client' — it has to be, it
// is a multi-step form — and a client component cannot hold a service-role
// call. A layout wrapping a single page runs exactly once per load of that
// page, which is the frequency wanted.
//
// WHY /onboarding NEEDS THIS AT ALL when both sign-in routes already call it.
// Somebody holding a LIVE SESSION and no players row passes through neither
// auth route again: the middleware reads players_self, sees nothing, and
// redirects here. That is every one of the 17 production accounts that already
// exist in auth without a row, and everybody who is mid-flow when this deploys.
// Without this they would stay in that state until they signed out and back in.
//
// Deliberately no redirect, no error, no gate. This layout's whole job is the
// one side effect; whether the row was made is the page's business, and the
// page already handles having one or not (completeOnboarding updates an
// existing row and creates one when there is none).
export const dynamic = 'force-dynamic';

export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const {
    data: { user },
  } = await (await createServerSupabaseClient()).auth.getUser();
  if (user) await ensurePlayerRowForUser(user.id);
  return <>{children}</>;
}

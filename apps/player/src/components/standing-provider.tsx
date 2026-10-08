'use client';

import { createContext, useContext } from 'react';
import type { AccountStanding } from '@badminton/shared';

// The signed-in member's account standing, published once from the root layout
// (which already loads their row) so that every client control can ask "will
// the server refuse me?" without each server page threading a prop down to it.
//
// The default is good standing on purpose: a component rendered outside the
// provider — a story, a test, an auth screen — must not start hiding controls
// because it happens to have no context. Being wrong in that direction only
// ever shows a button the server would then judge on its own merits, which is
// exactly today's behaviour.
const GOOD_STANDING: AccountStanding = { ok: true, block: null, reason: '', detail: '' };

const StandingContext = createContext<AccountStanding>(GOOD_STANDING);

export function StandingProvider({
  standing,
  children,
}: {
  standing: AccountStanding;
  children: React.ReactNode;
}) {
  return <StandingContext.Provider value={standing}>{children}</StandingContext.Provider>;
}

export function useStanding() {
  return useContext(StandingContext);
}

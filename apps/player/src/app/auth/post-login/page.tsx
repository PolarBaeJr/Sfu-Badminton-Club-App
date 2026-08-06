import { redirect } from 'next/navigation';
import { CHECKIN_TOKEN_REGEX } from '@badminton/shared';
import { getCurrentPlayer } from '@/lib/supabase-server';
import { reactivateLapsedMember } from '@/lib/reactivate';

// After a code-based sign-in the session cookie is already set client-side;
// this server route reads it and sends the user to the right place — onboarding
// if they have no player profile yet, otherwise the feed (or the session QR
// they scanned before signing in).
export const dynamic = 'force-dynamic';

export default async function PostLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ checkin?: string }>;
}) {
  const { checkin } = await searchParams;
  const player = await getCurrentPlayer();
  // Not just a missing profile: a row can exist with setup unfinished (the
  // signup function inserts it with onboarding_completed FALSE), and sending
  // that player to /feed skipped onboarding entirely.
  if (!player || !player.onboarding_completed) redirect('/onboarding');
  // Signing in is what brings a lapsed member back. Doing it HERE, before the
  // redirect, means the root layout's own standing/console query on the next
  // request already reads active_flag = true — the member never sees a banner
  // for a state they have just left. No-op for everyone else (and for a
  // removal or a pending deletion, which must not be undone by logging in).
  await reactivateLapsedMember(player);
  // Single-purpose token, re-validated here: it can only ever name a /checkin
  // route, so there's no arbitrary redirect target to abuse.
  if (checkin && CHECKIN_TOKEN_REGEX.test(checkin)) {
    redirect(`/checkin/${checkin}`);
  }
  redirect('/feed');
}

import { redirect } from 'next/navigation';
import { CHECKIN_TOKEN_REGEX } from '@badminton/shared';
import { getCurrentPlayer } from '@/lib/supabase-server';

// After a code-based sign-in the session cookie is already set client-side;
// this server route reads it and sends the user to the right place — onboarding
// if they have no player profile yet, otherwise the feed (or the session QR
// they scanned before signing in).
export const dynamic = 'force-dynamic';

export default async function PostLoginPage({
  searchParams,
}: {
  searchParams: { checkin?: string };
}) {
  const player = await getCurrentPlayer();
  if (!player) redirect('/onboarding');
  // Single-purpose token, re-validated here: it can only ever name a /checkin
  // route, so there's no arbitrary redirect target to abuse.
  if (searchParams.checkin && CHECKIN_TOKEN_REGEX.test(searchParams.checkin)) {
    redirect(`/checkin/${searchParams.checkin}`);
  }
  redirect('/feed');
}

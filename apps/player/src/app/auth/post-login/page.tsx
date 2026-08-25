import { redirect } from 'next/navigation';
import { CHECKIN_TOKEN_REGEX, DISCORD_LINK_TOKEN_REGEX } from '@badminton/shared';
import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { reactivateLapsedMember } from '@/lib/reactivate';
import { ensurePlayerRowForUser } from '@/lib/first-signin';

// After a code-based sign-in the session cookie is already set client-side;
// this server route reads it and sends the user to the right place — onboarding
// if they have no player profile yet, otherwise the feed (or the session QR
// they scanned before signing in).
export const dynamic = 'force-dynamic';

export default async function PostLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ checkin?: string; discord?: string }>;
}) {
  const { checkin, discord } = await searchParams;
  // First sign-in by OTP code or passkey lands here, and this is where the row
  // gets made (00132). Unlike /auth/callback the session cookie is already set
  // client-side by the time this route runs, so the user comes off next/headers
  // rather than off an exchange result. Idempotent and never throws — a member
  // whose row already exists pays one indexed lookup.
  const {
    data: { user },
  } = await (await createServerSupabaseClient()).auth.getUser();
  if (user) await ensurePlayerRowForUser(user.id);

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
  // The last hop of the Discord /link chain. Same single-purpose reasoning as
  // the check-in token above: it can only ever name a /link route.
  if (discord && DISCORD_LINK_TOKEN_REGEX.test(discord)) {
    redirect(`/link/${discord}`);
  }
  redirect('/feed');
}

import { redirect } from 'next/navigation';
import { createServerSupabaseClient, getViewer, getActiveSeason } from '@/lib/supabase-server';
import { Landing } from '@/components/landing';
import { getFeatureFlags } from '@/lib/feature-gate';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Un-onboarded players finish setup first; a signed-in member's home is the
  // schedule on /feed, which a pending or suspended member can read too. Only a
  // signed-out visitor sees the landing. A scanned check-in QR or a Discord
  // link token never comes through here: the sign-in callback sends those
  // straight to /checkin/<token> or /link/<token>.
  if (user) {
    const { player } = await getViewer();
    if (!player || !player.onboarding_completed) redirect('/onboarding');
    redirect('/feed');
  }

  // Pull the real top of the singles ladder so the hero shows live standings,
  // not placeholder copy.
  const { data: rows } = await supabase.rpc('get_leaderboard');
  const top = ((rows ?? []) as { name: string; singles_elo: number }[])
    .sort((a, b) => b.singles_elo - a.singles_elo)
    .slice(0, 5)
    .map((r) => ({ name: r.name, elo: r.singles_elo }));

  const [season, flags] = await Promise.all([getActiveSeason().catch(() => null), getFeatureFlags()]);

  return (
    <Landing
      top={top}
      seasonName={season?.name ?? null}
      isAuthenticated={!!user}
      guestWaiversOn={flags.guest_waivers}
    />
  );
}

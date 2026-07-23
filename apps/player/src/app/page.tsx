import { redirect } from 'next/navigation';
import { createServerSupabaseClient, getCurrentPlayer, getActiveSeason } from '@/lib/supabase-server';
import { Landing } from '@/components/landing';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Un-onboarded players finish setup first; everyone else sees the landing.
  if (user) {
    const player = await getCurrentPlayer();
    if (!player || !player.onboarding_completed) redirect('/onboarding');
  }

  // Pull the real top of the singles ladder so the hero shows live standings,
  // not placeholder copy.
  const { data: rows } = await supabase.rpc('get_leaderboard');
  const top = ((rows ?? []) as { name: string; singles_elo: number }[])
    .sort((a, b) => b.singles_elo - a.singles_elo)
    .slice(0, 5)
    .map((r) => ({ name: r.name, elo: r.singles_elo }));

  const season = await getActiveSeason().catch(() => null);

  return <Landing top={top} seasonName={season?.name ?? null} isAuthenticated={!!user} />;
}

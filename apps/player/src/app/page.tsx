import { redirect } from 'next/navigation';
import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';

export default async function Home() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const player = await getCurrentPlayer();

  if (!player) redirect('/onboarding');
  if (!player.onboarding_completed) redirect('/onboarding');
  redirect('/feed');
}

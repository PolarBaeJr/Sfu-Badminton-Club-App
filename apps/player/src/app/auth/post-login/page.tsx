import { redirect } from 'next/navigation';
import { getCurrentPlayer } from '@/lib/supabase-server';

// After a code-based sign-in the session cookie is already set client-side;
// this server route reads it and sends the user to the right place — onboarding
// if they have no player profile yet, otherwise the feed.
export const dynamic = 'force-dynamic';

export default async function PostLoginPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/onboarding');
  redirect('/feed');
}

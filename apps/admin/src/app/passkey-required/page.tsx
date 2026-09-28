export const dynamic = 'force-dynamic';
import { redirect } from 'next/navigation';
import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import { sanitizeNext } from '@/lib/safe-next';
import { CONSOLE_PASSKEY_GRACE_DAYS } from '@/lib/passkey/grace';
import { PasskeyRequiredActions } from './passkey-required-actions';

// Where the console sends someone whose days without a console passkey have
// run out (00262). The one console page that stays open to them: it enrols a
// passkey and sends them back to where they were going.
export default async function PasskeyRequiredPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const target = sanitizeNext(next);

  let player: Awaited<ReturnType<typeof getAuthenticatedConsoleUser>>;
  try {
    player = await getAuthenticatedConsoleUser({ skipPasskey: true });
  } catch {
    redirect('/login');
  }

  // Already holds one (enrolled in another tab, say): nothing to do here.
  const { count } = await createAdminClient()
    .from('passkey_credentials')
    .select('id', { count: 'exact', head: true })
    .eq('player_id', player.id)
    .eq('enrolled_via', 'admin');
  if ((count ?? 0) >= 1) redirect(target);

  return (
    <div className="min-h-screen flex items-center bg-[var(--bg-primary)]">
      <div className="max-w-xl w-full mx-auto px-6">
        <div className="page-eyebrow">
          <span className="bar" />
          Security check
        </div>
        <h1 className="page-title">Add a console passkey to continue</h1>
        <p className="page-sub">
          The console opens without a passkey for {CONSOLE_PASSKEY_GRACE_DAYS} days from your first visit.
          That time is up, so it now needs a passkey added here. It takes a few seconds on your phone,
          laptop or security key.
        </p>
        <PasskeyRequiredActions next={target} />
      </div>
    </div>
  );
}

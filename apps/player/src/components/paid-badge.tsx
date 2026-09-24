import { createServerSupabaseClient } from '@/lib/supabase-server';

// THE PUBLIC "PAID" BADGE: a member has paid this season's dues.
//
// Asked of player_season_paid() (00248), which answers yes or no and nothing
// else: never an amount, a method, or whether somebody is exempt or waived. It
// is granted to signed-in members only, so a signed-out visitor gets an error
// here and sees nothing. Unpaid members show nothing at all: the badge is for
// the people who paid, never a list of who did not.
//
// The caller gates it on the fees switch. Never throws: a failed read shows no
// badge rather than breaking a profile.
export async function PaidBadge({ playerId }: { playerId: string }) {
  let paid = false;
  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc('player_season_paid', { p_player_id: playerId });
    paid = !error && data === true;
  } catch {
    paid = false;
  }
  if (!paid) return null;
  return (
    <span
      className="pill pill-out"
      style={{ borderColor: 'var(--win)', color: 'var(--win)' }}
      title="Paid this season's membership"
    >
      PAID
    </span>
  );
}

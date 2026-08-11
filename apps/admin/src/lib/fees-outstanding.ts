import type { SupabaseClient } from '@supabase/supabase-js';
import { unwrap } from '@badminton/shared';
import { isWaivedFee } from './fee-status';

/**
 * HOW MUCH SEASON MONEY IS STILL OWED, IN CENTS.
 *
 * The dashboard's "fees outstanding" cell is an AMOUNT; /fees shows a COUNT of
 * people. They are two readings of one ledger, so the predicate that decides
 * whether a person still owes lives here, in a module with a test on it, rather
 * than a second time inside a page component that nothing can render in a unit
 * test. season-income.ts sets that norm and says why: a total assembled by a
 * page that only remembered some of the rules is how the income figure came to
 * be wrong the first time.
 *
 * WHO IS BILLABLE is transcribed from fees/page.tsx and must stay identical to
 * it: active competitive/recreational members who are neither exec nor
 * fee-exempt. A dashboard that counted a different population would print a
 * figure that contradicts the page it links to.
 *
 * WHAT THEY OWE is the flat per-status fee on the season row. Those two columns
 * are the club's PRICE LIST, and reading them is the caller's decision, not
 * this function's — see the note on BillableSeason.
 *
 * PAID AND WAIVED BOTH SETTLE. A waiver is stored as a paid row with
 * amount_cents 0 and method 'waived' (fee-status.ts), so both carry `paid_at`;
 * the predicate is written out in the same two halves fees/page.tsx uses so
 * that a change to what "waived" means reaches both through the shared helper.
 */

/**
 * The season, WITH its price list.
 *
 * `competitive_fee_cents` / `recreational_fee_cents` are the club's prices, and
 * a sibling agent found /fees shipping them to anybody who could read the
 * expense ledger. They are not page furniture: the caller must have selected
 * them under `fees.clubfees.read` and no weaker gate.
 */
export interface BillableSeason {
  id: string;
  competitive_fee_cents: number;
  recreational_fee_cents: number;
}

export async function getOutstandingClubFees(
  supabase: SupabaseClient,
  season: BillableSeason,
): Promise<number> {
  const [rosterResult, feesResult] = await Promise.all([
    supabase
      .from('players')
      .select('id, status')
      .in('status', ['competitive', 'recreational'])
      .eq('is_exec', false)
      .eq('fee_exempt', false),
    supabase
      .from('club_fees')
      .select('player_id, paid_at, method')
      .eq('season_id', season.id),
  ]);

  // unwrap() rather than `?? []`: a query that errored would otherwise read as
  // "nobody owes anything", which is the most dangerous possible failure for a
  // money figure — it produces a plausible number that is short by whatever the
  // failed query held.
  const roster = unwrap(rosterResult as { data: { id: string; status: string }[] | null; error: { message: string } | null });
  const fees = unwrap(feesResult as { data: { player_id: string | null; paid_at: string | null; method: string | null }[] | null; error: { message: string } | null });

  const feeByPlayer = new Map(
    fees.filter((f) => f.player_id != null).map((f) => [f.player_id as string, f]),
  );

  return roster.reduce((cents, player) => {
    const fee = feeByPlayer.get(player.id);
    const waived = isWaivedFee(fee);
    const paid = Boolean(fee?.paid_at) && !waived;
    if (paid || waived) return cents;
    return (
      cents +
      (player.status === 'competitive'
        ? season.competitive_fee_cents
        : season.recreational_fee_cents)
    );
  }, 0);
}

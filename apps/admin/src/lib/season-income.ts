import type { SupabaseClient } from '@supabase/supabase-js';
import { unwrap } from '@badminton/shared';

/**
 * Money the club actually took in during a season.
 *
 * There are three fee ledgers and the "income collected" figure used to sum
 * only one of them (club_fees), so a recorded reinstatement or tournament
 * payment left the total reading $0.00 while the money was sitting in the
 * database. Two pages computed that total independently, which is how they
 * agreed on being wrong.
 *
 * The ledgers reach a season by different routes, which is the whole
 * reason this is a function and not a query:
 *
 *   club_fees          season_id directly
 *   tournament_fees    via tournaments.season_id
 *   reinstatement_fees season_id directly, since 00069
 *   other_income       season_id directly, NOT NULL, since 00073
 *
 * reinstatement_fees used to be bucketed by paid_at, because it had no season
 * column. Money paid outside every season window then belonged to no season and
 * showed in no total — a real $20 payment was invisible because it was taken
 * three weeks before the season it was for began. It now carries the season it
 * was recorded under, so the gap between terms cannot swallow a payment.
 *
 * EVERY LEDGER IS FOLDED INTO totalCents HERE, and a caller wanting "income"
 * reads that field rather than adding ledgers up itself. other_income
 * (donations, grants, socials) was added to this function for that reason and
 * reached both /fees and /dashboard at once: a total assembled out of parts by
 * a page that only remembered some of them is precisely how the figure came to
 * be wrong the first time.
 *
 * The per-ledger helpers below are NOT that. They exist because seeing a ledger
 * is a per-ledger permission — fees.clubfees.read and fees.otherincome.read are
 * separate capabilities — so a caller allowed one figure can fetch that one
 * without reading books it may not see. This function calls them, so each sum
 * still has one implementation and the total still has one assembly point;
 * what is forbidden is a second piece of arithmetic, not a second entry point.
 *
 * Only rows with paid_at set count, in EVERY ledger — one rule, not one per
 * table. An unpaid or waived row is a liability, not income.
 */
export interface SeasonIncome {
  /** Everything below, added up. This is the number to show as "income". */
  totalCents: number;
  clubCents: number;
  tournamentCents: number;
  reinstatementCents: number;
  /** Donations, grants, socials — 00073. */
  otherCents: number;
}

/** Only the id is needed now that all three ledgers carry a real season key. */
export interface SeasonWindow {
  id: string;
}

/**
 * Sum one ledger's rows, REFUSING to treat a failed query as an empty one.
 *
 * This used to be `(rows ?? []).reduce(...)` over `result.data`, which reads a
 * query that errored as a ledger containing nothing. That is the worst possible
 * failure for a money figure: it produces a number, the number looks fine, and
 * it is short by however much the failed ledger held. The first time it would
 * have bitten is the deploy of 00073 itself — the console ships through CI
 * while migrations are applied BY HAND, so between the two there is a window
 * where other_income does not exist yet and every query against it fails.
 * Silently, that window reports a plausible wrong total; loudly, it reports an
 * error somebody fixes by applying the migration.
 *
 * unwrap() is the repo's existing helper for exactly this and throws on error.
 */
const sum = (result: { data: { amount_cents: number | null }[] | null; error: unknown }): number =>
  unwrap(result as { data: { amount_cents: number | null }[] | null; error: { message: string } | null })
    .reduce((acc, r) => acc + (r.amount_cents ?? 0), 0);

/**
 * ONE LEDGER, ON ITS OWN — club fees, and nothing else.
 *
 * For the caller who may see this ledger and no other. Drawing the figure out
 * of getSeasonIncome instead would read the club's tournament money and
 * reinstatements on their behalf, which is the leak the fetch gating on /fees
 * and /dashboard exists to prevent. See the note on the interface above.
 */
export async function getClubFeeIncome(
  supabase: SupabaseClient,
  season: SeasonWindow,
): Promise<number> {
  return sum(
    await supabase
      .from('club_fees')
      .select('amount_cents')
      .eq('season_id', season.id)
      .not('paid_at', 'is', null),
  );
}

/**
 * The other-income ledger on its own — donations, grants, socials (00073).
 * Same reason as getClubFeeIncome above, and the same paid_at rule.
 */
export async function getOtherIncome(
  supabase: SupabaseClient,
  season: SeasonWindow,
): Promise<number> {
  return sum(
    await supabase
      .from('other_income')
      .select('amount_cents')
      .eq('season_id', season.id)
      .not('paid_at', 'is', null),
  );
}

export async function getSeasonIncome(
  supabase: SupabaseClient,
  season: SeasonWindow,
): Promise<SeasonIncome> {
  const [clubCents, tournament, reinstatement, otherCents] = await Promise.all([
    getClubFeeIncome(supabase, season),

    // Inner join: a fee whose tournament is not in this season must not count.
    supabase
      .from('tournament_fees')
      .select('amount_cents, tournaments!inner(season_id)')
      .eq('tournaments.season_id', season.id)
      .not('paid_at', 'is', null),

    supabase
      .from('reinstatement_fees')
      .select('amount_cents')
      .eq('season_id', season.id)
      .not('paid_at', 'is', null),

    // 00073. season_id is NOT NULL here, so unlike reinstatements there is no
    // "attached to no season" row to worry about — but the paid_at rule is the
    // same, so a row recorded before the money actually arrived stays out.
    getOtherIncome(supabase, season),
  ]);

  const tournamentCents = sum(tournament);
  const reinstatementCents = sum(reinstatement);

  return {
    clubCents,
    tournamentCents,
    reinstatementCents,
    otherCents,
    totalCents: clubCents + tournamentCents + reinstatementCents + otherCents,
  };
}

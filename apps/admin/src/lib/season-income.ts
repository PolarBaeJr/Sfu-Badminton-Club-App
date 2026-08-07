import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Money the club actually took in during a season.
 *
 * There are three fee ledgers and the "income collected" figure used to sum
 * only one of them (club_fees), so a recorded reinstatement or tournament
 * payment left the total reading $0.00 while the money was sitting in the
 * database. Two pages computed that total independently, which is how they
 * agreed on being wrong.
 *
 * The three ledgers reach a season by different routes, which is the whole
 * reason this is a function and not a query:
 *
 *   club_fees          season_id directly
 *   tournament_fees    via tournaments.season_id
 *   reinstatement_fees season_id directly, since 00069
 *
 * reinstatement_fees used to be bucketed by paid_at, because it had no season
 * column. Money paid outside every season window then belonged to no season and
 * showed in no total — a real $20 payment was invisible because it was taken
 * three weeks before the season it was for began. It now carries the season it
 * was recorded under, so the gap between terms cannot swallow a payment.
 *
 * Only rows with paid_at set count. An unpaid or waived row is a liability, not
 * income.
 */
export interface SeasonIncome {
  /** Everything below, added up. This is the number to show as "income". */
  totalCents: number;
  clubCents: number;
  tournamentCents: number;
  reinstatementCents: number;
}

/** Only the id is needed now that all three ledgers carry a real season key. */
export interface SeasonWindow {
  id: string;
}

const sum = (rows: { amount_cents: number | null }[] | null): number =>
  (rows ?? []).reduce((acc, r) => acc + (r.amount_cents ?? 0), 0);

export async function getSeasonIncome(
  supabase: SupabaseClient,
  season: SeasonWindow,
): Promise<SeasonIncome> {
  const [club, tournament, reinstatement] = await Promise.all([
    supabase
      .from('club_fees')
      .select('amount_cents')
      .eq('season_id', season.id)
      .not('paid_at', 'is', null),

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
  ]);

  const clubCents = sum(club.data);
  const tournamentCents = sum(tournament.data);
  const reinstatementCents = sum(reinstatement.data);

  return {
    clubCents,
    tournamentCents,
    reinstatementCents,
    totalCents: clubCents + tournamentCents + reinstatementCents,
  };
}

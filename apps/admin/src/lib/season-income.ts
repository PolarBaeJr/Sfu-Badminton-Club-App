import type { SupabaseClient } from '@supabase/supabase-js';
import { unwrap, type FeeType } from '@badminton/shared';

/**
 * Money the club actually took in during a season.
 *
 * ONE FEE TABLE NOW, THREE KINDS OF ROW IN IT (00094). This function used to
 * read club_fees, tournament_fees and reinstatement_fees and add them up; the
 * first two are the same table since the collapse, and the arithmetic that
 * matters is that EACH PAYMENT IS COUNTED EXACTLY ONCE. A version of this file
 * that kept the old tournament_fees branch alongside a club_fees sum would
 * double every entry fee in the club's income — which is the specific hazard
 * the collapse creates and the reason season-income.test.ts makes any read of
 * the retired tables throw.
 *
 *   club_fees    season_id directly, split by fee_type
 *   other_income season_id directly, NOT NULL, since 00073
 *
 * SEASON IS A COLUMN, NEVER A JOIN AND NEVER A DATE WINDOW. Entry fees used to
 * reach a season through tournaments.season_id; they now carry the season
 * stamped on at entry, which is the rule 00069 arrived at the hard way for
 * reinstatements (money paid three weeks before its season began belonged to no
 * season and was invisible in every total) and the rule 00084 restated for
 * corrections. The cost, stated plainly: moving a tournament to another season
 * afterwards no longer moves the entry money with it. That is the intended
 * behaviour — recorded money does not migrate — and an exec who really wants it
 * moved edits the fee rows.
 *
 * A row whose season_id is NULL — an entry fee for a tournament with no season,
 * a reinstatement taken between terms — belongs to no season's income. That is
 * unchanged from before the collapse and deliberate; reinstatePlayer refuses to
 * create one, see its comment.
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
 * kind. An unpaid or waived row is a liability, not income.
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
 * One KIND of fee, summed for one season.
 *
 * `.eq('fee_type', …)` is not a nicety. Since the collapse the same table holds
 * dues, entry fees and reinstatements, and the three figures below have to
 * partition it — a sum without this filter is every fee three times over. It is
 * also the permission boundary: fees.clubfees.read and fees.reinstatements.read
 * are separate capabilities, so an unfiltered read hands one holder the other's
 * ledger.
 */
async function feeIncome(
  supabase: SupabaseClient,
  season: SeasonWindow,
  feeType: FeeType,
): Promise<number> {
  return sum(
    await supabase
      .from('club_fees')
      .select('amount_cents')
      .eq('season_id', season.id)
      .eq('fee_type', feeType)
      .not('paid_at', 'is', null),
  );
}

/**
 * SEASON DUES, ON THEIR OWN — and nothing else in the table.
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
  return feeIncome(supabase, season, 'dues');
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
  // THREE DISJOINT SLICES OF ONE TABLE, plus other_income. fee_type is a
  // single NOT NULL column with a three-value CHECK, so these three filters
  // cannot overlap and cannot leave a paid fee out: the only way a row escapes
  // all three is a fourth fee_type, which the CHECK forbids. That is what makes
  // "counted exactly once" a property of the schema rather than a hope.
  const [clubCents, tournamentCents, reinstatementCents, otherCents] = await Promise.all([
    getClubFeeIncome(supabase, season),
    feeIncome(supabase, season, 'tournament'),
    feeIncome(supabase, season, 'reinstatement'),

    // 00073. season_id is NOT NULL here, so unlike fees there is no "attached
    // to no season" row to worry about — but the paid_at rule is the same, so a
    // row recorded before the money actually arrived stays out.
    getOtherIncome(supabase, season),
  ]);

  return {
    clubCents,
    tournamentCents,
    reinstatementCents,
    otherCents,
    totalCents: clubCents + tournamentCents + reinstatementCents + otherCents,
  };
}

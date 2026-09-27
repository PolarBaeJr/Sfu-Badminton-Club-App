// A member's own statement, built the way /membership builds it
// (apps/player/src/app/membership/member-section.tsx) from the same rows and
// the same shared ledger rules, so the phone and the website print one figure.
import {
  money,
  settlementOf,
  type FeeKind,
  type FeeLine,
  type OutstandingSummary,
} from '@badminton/shared/src/utils/fee-statement';

/** The member's own fee rows, as apps/player/src/lib/member-fees.ts reads them. */
export const OWN_FEE_COLUMNS =
  'id, fee_type, season_id, tournament_id, club_event_id, amount_cents, paid_at, method, reference, created_at, ' +
  'fee_submissions(id, status, reference, reject_reason, submitted_at)';

export interface OwnFeeRow {
  id: string;
  fee_type: string;
  season_id: string | null;
  tournament_id: string | null;
  club_event_id: string | null;
  amount_cents: number | null;
  paid_at: string | null;
  method: string | null;
  reference: string | null;
  created_at: string;
}

export interface StatementSeason {
  id: string;
  name: string;
  end_date: string | null;
  competitive_fee_cents: number;
  recreational_fee_cents: number;
}

export interface StatementPlayer {
  status: string | null;
  is_exec: boolean | null;
  fee_exempt: boolean | null;
}

/** Competitive pays the competitive price, everybody else the recreational one. */
export function seasonFeeFor(status: string | null | undefined, season: StatementSeason): number {
  return status === 'competitive' ? season.competitive_fee_cents : season.recreational_fee_cents;
}

export function isExempt(player: StatementPlayer): boolean {
  return Boolean(player.is_exec || player.fee_exempt);
}

/**
 * Every line of the statement, in the web's order: this season's dues, then
 * tournament entries and club events by name, then reinstatements.
 *
 * A member with no dues row yet still owes the season's price, keyed on the
 * season. An exempt member gets no dues line at all; summariseFees then keeps
 * only reinstatements chargeable, because a reinstatement is not a due.
 */
export function buildStatementLines(input: {
  player: StatementPlayer;
  season: StatementSeason | null;
  feeRows: readonly OwnFeeRow[];
  tournamentNames: ReadonlyMap<string, string>;
  eventNames: ReadonlyMap<string, string>;
}): { lines: FeeLine[]; seasonLine: FeeLine | null } {
  const { player, season, feeRows, tournamentNames, eventNames } = input;
  const lines: FeeLine[] = [];
  let seasonLine: FeeLine | null = null;

  if (season && !isExempt(player)) {
    const clubFee = feeRows.find((f) => f.fee_type === 'dues' && f.season_id === season.id);
    const { paid, waived } = settlementOf(clubFee ?? {});
    seasonLine = {
      key: clubFee?.id ?? `season-${season.id}`,
      kind: 'season',
      name: `${season.name} membership`,
      owedCents:
        clubFee?.paid_at != null
          ? clubFee.amount_cents
          : (clubFee?.amount_cents ?? seasonFeeFor(player.status, season)),
      recordedCents: clubFee?.amount_cents ?? null,
      paid,
      waived,
      paidAt: clubFee?.paid_at ?? null,
      method: clubFee?.method ?? null,
      reference: clubFee?.reference ?? null,
    };
    lines.push(seasonLine);
  }

  const fromRow = (fee: OwnFeeRow, kind: FeeKind, name: string): FeeLine => {
    const { paid, waived } = settlementOf(fee);
    return {
      key: fee.id,
      kind,
      name,
      owedCents: fee.amount_cents,
      recordedCents: fee.amount_cents,
      paid,
      waived,
      paidAt: fee.paid_at,
      method: fee.method,
      reference: fee.reference,
    };
  };

  lines.push(
    ...feeRows
      .filter((f) => f.fee_type === 'tournament' && f.tournament_id)
      .map((f) => fromRow(f, 'tournament', tournamentNames.get(f.tournament_id as string) ?? 'Tournament entry'))
      .sort((a, b) => a.name.localeCompare(b.name)),
    ...feeRows
      .filter((f) => f.fee_type === 'event' && f.club_event_id)
      .map((f) => fromRow(f, 'event', eventNames.get(f.club_event_id as string) ?? 'Club event'))
      .sort((a, b) => a.name.localeCompare(b.name)),
    ...feeRows.filter((f) => f.fee_type === 'reinstatement').map((f) => fromRow(f, 'reinstatement', 'Reinstatement fee')),
  );

  return { lines, seasonLine };
}

/**
 * The figure and the word beside it. Same answers as the web's headlineAmount
 * and headlineBadge in apps/player/src/lib/fees.ts: an exempt member is "not
 * charged", never "all paid", and an unpriced line makes the total unknown
 * rather than zero.
 */
export function statementHeadline(s: OutstandingSummary): { amount: string; label: string } {
  let amount: string;
  if (s.status === 'exempt' || s.status === 'nothing-due') amount = '$0.00';
  else if (s.totalCents === 0 && s.unknownCount > 0) amount = money(null);
  else amount = money(s.totalCents);
  const label =
    s.status === 'exempt'
      ? 'NOT CHARGED'
      : s.status === 'nothing-due'
        ? 'NOTHING DUE'
        : s.status === 'all-paid'
          ? 'ALL PAID'
          : 'UNPAID';
  return { amount, label };
}

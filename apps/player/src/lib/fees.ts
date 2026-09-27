// Derivations behind /fees — the money rules, as pure functions over the rows
// the page reads, so they can be tested without a database.
//
// The screen answers one question ("what do I owe?") from one ledger holding
// four kinds of row (00094, 00248): dues per season, entry fees per tournament,
// reinstatements per ban episode, and club event costs per sign-up. Flattening them to one FeeLine shape here is
// what lets the headline figure, the badge and the receipt list agree — they
// are three readings of the same array rather than three separate sums, which
// is how the admin side ended up counting fees in one place and people in
// another.
//
// FeeKind mirrors club_fees.fee_type and is deliberately a separate type: it
// drives the WORDING (a "Reinstatement fee" is not a "membership") and, in
// summariseFees (now in fee-statement.ts), the one place the two differ in arithmetic: exemption.

import { formatPaymentMethod } from '@badminton/shared';
import { money, type FeeLine, type FeeKind, type OutstandingSummary } from '@badminton/shared/src/utils/fee-statement';

// The ledger arithmetic moved to packages/shared so the phone app computes the
// same figure; re-exported here so every @/lib/fees caller keeps its import.
export {
  money,
  settlementOf,
  isSettled,
  summariseFees,
} from '@badminton/shared/src/utils/fee-statement';
export type { FeeKind, FeeLine, FeeStatus, OutstandingSummary } from '@badminton/shared/src/utils/fee-statement';

/**
 * Whether an outstanding line gets the receipt form. A reinstatement is settled
 * with an exec, a line with no price has nothing to pay yet, and a line with a
 * receipt waiting has one in. Dues can be bought on the SFU Rec website; every
 * other line is paid by e-transfer, so it needs the club's address set. The
 * submit action refuses the same cases.
 */
export function canUploadReceipt(line: {
  kind: FeeKind;
  owedCents: number | null;
  waiting: boolean;
  etransferConfigured: boolean;
}): boolean {
  return (
    line.kind !== 'reinstatement' &&
    line.owedCents != null &&
    !line.waiting &&
    (line.etransferConfigured || line.kind === 'season')
  );
}

// ------------------------------------------------------------------
// The headline figure
// ------------------------------------------------------------------

/**
 * The 46px figure. Returns null when there is no figure to print — 'exempt' and
 * 'nothing-due' get a word instead, because "$0.00" invites the reading "your
 * fee is zero dollars" when the truth is "you were never billed".
 */
export function headlineAmount(s: OutstandingSummary): string {
  if (s.status === 'exempt' || s.status === 'nothing-due') return '$0.00';
  // An outstanding line with no recorded price and nothing else owed: the total
  // is genuinely unknown, not zero.
  if (s.totalCents === 0 && s.unknownCount > 0) return money(null);
  return money(s.totalCents);
}

/** The badge beside it. `tone` maps straight onto Badge's variants. */
export function headlineBadge(s: OutstandingSummary): {
  tone: 'success' | 'warning' | 'neutral';
  label: string;
} {
  switch (s.status) {
    case 'exempt':
      return { tone: 'neutral', label: 'NOT CHARGED' };
    case 'nothing-due':
      return { tone: 'neutral', label: 'NOTHING DUE' };
    case 'all-paid':
      return { tone: 'success', label: 'ALL PAID' };
    default:
      return { tone: 'warning', label: 'UNPAID' };
  }
}

// ------------------------------------------------------------------
// Dates
// ------------------------------------------------------------------

const CLUB_TZ = 'America/Vancouver';

/**
 * "6 JAN" from a Postgres DATE.
 *
 * Formatted in UTC on purpose. A DATE column arrives as '2026-01-06', which
 * `new Date()` parses as UTC midnight; rendering that in America/Vancouver
 * (UTC-8) shows 5 January. shared's formatDate() has exactly this bug for date
 * columns, so this does not reuse it.
 */
export function formatDayMonth(date: string | null | undefined): string | null {
  if (!date) return null;
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .toUpperCase();
}

/**
 * "8 JAN" from a TIMESTAMPTZ. Rendered in the club's timezone — a payment taken
 * at 5pm Vancouver on the 8th is the 8th, not the 9th in UTC.
 */
export function formatPaidDay(timestamp: string | null | undefined): string | null {
  if (!timestamp) return null;
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  return d
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: CLUB_TZ })
    .toUpperCase();
}

/**
 * The dateline under the title: "6 JAN – 4 MAY", or "FROM 6 JAN" when the
 * season has no end date (seasons.end_date is nullable and an open-ended season
 * is a real thing between terms).
 */
export function seasonDateline(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): string | null {
  const start = formatDayMonth(startDate);
  if (!start) return null;
  const end = formatDayMonth(endDate);
  return end ? `${start} – ${end}` : `FROM ${start}`;
}

// ------------------------------------------------------------------
// Receipt lines
// ------------------------------------------------------------------

/**
 * "8 JAN · E-TRANSFER · RC-2261" — with every segment that has no value simply
 * absent, rather than a placeholder.
 *
 * method and reference are both optional columns filled in by hand, so a real
 * production row can easily have neither. The mockup's row always showed all
 * three; a row reading "8 JAN · — · —" is worse than one reading "8 JAN".
 */
export function receiptMeta(line: FeeLine): { text: string; reference: string | null } {
  const segments: string[] = [];
  const day = formatPaidDay(line.paidAt);
  if (day) segments.push(day);
  if (line.waived) {
    segments.push('WAIVED');
  } else {
    const method = formatPaymentMethod(line.method).toUpperCase();
    if (method) segments.push(method);
  }
  const reference = line.reference?.trim() || null;
  return { text: segments.join(' · '), reference };
}

/**
 * The hairline footer on the OUTSTANDING card.
 *
 * The mockup read "TERM FEE PAID 8 JAN · NOTHING DUE UNTIL 4 MAY". The second
 * half is dropped: no table has a due date, so a deadline here would be
 * invented, and an invented deadline on a fees screen is the kind of wrong that
 * gets someone told they are late. What replaces it is the season's real
 * end_date, stated as what it is — when the season ends, not when money is due.
 */
export function outstandingFooter(
  seasonLine: FeeLine | null,
  seasonEndDate: string | null | undefined,
): string | null {
  const parts: string[] = [];
  if (seasonLine?.waived) {
    parts.push('TERM FEE WAIVED');
  } else if (seasonLine?.paid) {
    const day = formatPaidDay(seasonLine.paidAt);
    parts.push(day ? `TERM FEE PAID ${day}` : 'TERM FEE PAID');
  } else if (seasonLine) {
    parts.push('TERM FEE NOT YET RECORDED');
  }
  const end = formatDayMonth(seasonEndDate);
  if (end) parts.push(`SEASON ENDS ${end}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

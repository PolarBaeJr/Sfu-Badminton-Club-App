// Derivations behind /fees — the money rules, as pure functions over the rows
// the page reads, so they can be tested without a database.
//
// The screen answers one question ("what do I owe?") from one ledger holding
// three kinds of row (00094): dues per season, entry fees per tournament, and
// reinstatements per ban episode. Flattening them to one FeeLine shape here is
// what lets the headline figure, the badge and the receipt list agree — they
// are three readings of the same array rather than three separate sums, which
// is how the admin side ended up counting fees in one place and people in
// another.
//
// FeeKind mirrors club_fees.fee_type and is deliberately a separate type: it
// drives the WORDING (a "Reinstatement fee" is not a "membership") and, in
// summariseFees below, the one place the two differ in arithmetic — exemption.

import { formatPaymentMethod, isReservedMethod } from '@badminton/shared';

// ------------------------------------------------------------------
// Money
// ------------------------------------------------------------------

/**
 * A price, or the honest admission that nothing records one.
 *
 * `amount_cents` is nullable on every kind of fee row, and an entry made when
 * the tournament had no matching tier has no price anywhere. Rendering that as
 * "$0.00" would tell a member they owe nothing for an event they will be asked
 * to pay for at the door. 'TBD' is the vocabulary the page already used before
 * the redesign; it is kept rather than replaced.
 */
export function money(cents: number | null | undefined): string {
  return cents == null ? 'TBD' : `$${(cents / 100).toFixed(2)}`;
}

// ------------------------------------------------------------------
// One thing that costs money
// ------------------------------------------------------------------

/** Which kind of fee a line came from. Drives the wording, not the arithmetic. */
export type FeeKind = 'season' | 'tournament' | 'reinstatement';

export interface FeeLine {
  /** Stable React key. The row's own uuid where there is one. */
  key: string;
  kind: FeeKind;
  /** What the money is for, in the member's words. */
  name: string;
  /**
   * Cents owed. For a season fee with no row yet this is the season's list
   * price; for everything else it is the row's own amount, and null when
   * nothing records one.
   */
  owedCents: number | null;
  /**
   * The row's OWN amount_cents, never a fallback. What a receipt must print: a
   * settled row whose amount was never filled in shows 'TBD' rather than a tier
   * price the club may not actually have taken.
   */
  recordedCents: number | null;
  /** `paid_at` is set and the method is not the reserved 'waived'. */
  paid: boolean;
  /** `paid_at` is set and method === 'waived' — settled, but no money moved. */
  waived: boolean;
  /** ISO timestamp from `paid_at`. Null while the line is outstanding. */
  paidAt: string | null;
  /** `method`, as stored. Null when the exec did not record one. */
  method: string | null;
  /** `reference` (00039 / 00059) — the exec's transaction id. Free text. */
  reference: string | null;
}

/**
 * Reads a ledger row's payment columns into the three-way settled state.
 *
 * `isReservedMethod` rather than `method === 'waived'`: payment-methods.ts owns
 * that word (a waived fee is stored as a paid row with amount_cents 0 so income
 * sums stay right), and it matches case-insensitively because a custom method
 * typed as "Waived" is the same intent.
 */
export function settlementOf(row: { paid_at?: string | null; method?: string | null }): {
  paid: boolean;
  waived: boolean;
} {
  const settled = row.paid_at != null;
  const waived = settled && isReservedMethod(row.method);
  return { paid: settled && !waived, waived };
}

/** Settled either way — paid for, or written off. Not money the member owes. */
export function isSettled(line: FeeLine): boolean {
  return line.paid || line.waived;
}

// ------------------------------------------------------------------
// The headline figure
// ------------------------------------------------------------------

/**
 * Four states, not two.
 *
 * The mockup had a binary — success when the figure is zero, warning otherwise
 * — and zero is three different things here:
 *
 *   'exempt'      execs and fee_exempt members are never charged. "ALL PAID" is
 *                 a lie to someone who was never billed.
 *   'nothing-due' no active season, no tournament entries, no ban to lift. Also
 *                 never billed, but for a reason that will change next term.
 *   'all-paid'    genuinely billed and genuinely settled. The one that earns
 *                 the success tone.
 *   'owing'       anything unsettled, including a brand-new member who has a
 *                 season fee and no payment yet.
 */
export type FeeStatus = 'exempt' | 'nothing-due' | 'all-paid' | 'owing';

export interface OutstandingSummary {
  status: FeeStatus;
  /** Sum of the KNOWN amounts still owed, in cents. */
  totalCents: number;
  /**
   * Unsettled lines whose price nothing records. Non-zero means `totalCents` is
   * a floor, not the answer — the page must say so rather than print a figure
   * that quietly omits a row. Same failure the admin finance tests name.
   */
  unknownCount: number;
  /** Unsettled lines, in the order given. */
  outstanding: FeeLine[];
  /** Settled lines, newest payment first. The receipt list. */
  receipts: FeeLine[];
}

export function summariseFees(lines: FeeLine[], opts: { exempt: boolean }): OutstandingSummary {
  const receipts = lines
    .filter(isSettled)
    // paid_at is non-null for everything that passed isSettled, but the sort has
    // to survive a row where it somehow is not rather than throw.
    .sort((a, b) => (b.paidAt ?? '').localeCompare(a.paidAt ?? ''));

  // Exemption is from DUES, and only from dues. is_exec / fee_exempt take a
  // member out of the club-fee table (apps/admin/src/app/fees/page.tsx filters
  // on exactly those two columns) and out of tournament entry fees —
  // ensureEntryFees skips them outright, so no row is even filed. They do not
  // touch reinstatement rows, which have no exemption check anywhere — a
  // reinstatement is not a due, it is the price of lifting a ban. Zeroing one
  // here would tell an exempt member they owe nothing while the club is still
  // waiting to be paid.
  const chargeable = opts.exempt ? lines.filter((l) => l.kind === 'reinstatement') : lines;

  const outstanding = chargeable.filter((l) => !isSettled(l));
  const totalCents = outstanding.reduce((sum, l) => sum + (l.owedCents ?? 0), 0);
  const unknownCount = outstanding.filter((l) => l.owedCents == null).length;

  let status: FeeStatus;
  if (outstanding.length > 0) status = 'owing';
  // Deliberately AFTER 'owing' and deliberately keeping `receipts`: an exec who
  // paid their dues before being made an exec has a real payment history, and
  // hiding it would look like the record had been deleted.
  else if (opts.exempt) status = 'exempt';
  else if (lines.length > 0) status = 'all-paid';
  else status = 'nothing-due';

  return { status, totalCents, unknownCount, outstanding, receipts };
}

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

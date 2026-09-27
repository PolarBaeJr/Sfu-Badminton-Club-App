// The money rules behind a member's own statement, as pure functions over the
// rows the screen reads, so they can be tested without a database.
//
// Moved from apps/player/src/lib/fees.ts, which re-exports them, so
// the phone app (apps/mobile) prints the same headline figure as /membership.
// Deliberately NOT exported from the shared barrel: the barrel also pulls the
// email sender and node crypto, which Metro cannot bundle, so the phone app
// imports this file by its path. It depends only on ./payment-methods.
//
// The screen answers one question ("what do I owe?") from one ledger holding
// four kinds of row (00094, 00248): dues per season, entry fees per tournament,
// reinstatements per ban episode, and club event costs per sign-up. Flattening them to one FeeLine shape here is
// what lets the headline figure, the badge and the receipt list agree: they
// are three readings of the same array rather than three separate sums, which
// is how the admin side ended up counting fees in one place and people in
// another.
//
// FeeKind mirrors club_fees.fee_type and is deliberately a separate type: it
// drives the WORDING (a "Reinstatement fee" is not a "membership") and, in
// summariseFees below, the one place the two differ in arithmetic: exemption.

import { isReservedMethod } from './payment-methods';

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
export type FeeKind = 'season' | 'tournament' | 'reinstatement' | 'event';

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
  /** `paid_at` is set and method === 'waived': settled, but no money moved. */
  waived: boolean;
  /** ISO timestamp from `paid_at`. Null while the line is outstanding. */
  paidAt: string | null;
  /** `method`, as stored. Null when the exec did not record one. */
  method: string | null;
  /** `reference` (00039 / 00059): the exec's transaction id. Free text. */
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

/** Settled either way: paid for, or written off. Not money the member owes. */
export function isSettled(line: FeeLine): boolean {
  return line.paid || line.waived;
}

// ------------------------------------------------------------------
// The headline figure
// ------------------------------------------------------------------

/**
 * Four states, not two.
 *
 * The mockup had a binary (success when the figure is zero, warning otherwise)
 * and zero is three different things here:
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
   * a floor, not the answer: the page must say so rather than print a figure
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
  // on exactly those two columns) and out of tournament entry fees:
  // ensureEntryFees skips them outright, so no row is even filed, and the
  // club event sign-up trigger (00248) skips them the same way. They do not
  // touch reinstatement rows, which have no exemption check anywhere: a
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

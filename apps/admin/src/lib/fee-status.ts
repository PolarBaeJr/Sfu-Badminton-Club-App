// A waiver is stored as a paid row with amount_cents 0 and method 'waived', so
// income sums stay correct without a separate column. Reading that back takes a
// two-field test, and the fees page and waiveFee both have to agree on it — the
// page to render "Waived" instead of "Paid $0.00", waiveFee to tell a genuine
// payment apart from a re-waive it may safely overwrite.
//
// NOT a 'use server' module: this is a plain predicate imported by both a
// server component and a server action.
export function isWaivedFee(fee?: { paid_at: string | null; method: string | null } | null): boolean {
  return Boolean(fee?.paid_at) && fee?.method === 'waived';
}

/** Everything the three figures need off a fee row. */
export interface FeeStatusRow {
  paid_at: string | null;
  method: string | null;
}

export interface FeeCollection {
  /** Rows in the table these figures sit above. paid + outstanding + waived. */
  total: number;
  paid: number;
  outstanding: number;
  waived: number;
}

/**
 * Paid / Outstanding / Waived for the fees stat strip.
 *
 * TAKES ONE LIST, on purpose. The strip used to be assembled from two
 * populations: Paid was `paidPlayers + manualFees.length` while Outstanding was
 * `players.length - paidPlayers - waivedPlayers`, so the two numbers sitting
 * side by side were counted over different sets and read as if they were not.
 * Worse, the roster half TESTED whether a fee was paid (`paid_at` and not
 * waived) and the manual half ASSUMED it — `.length`, unconditionally — so a
 * manual entry carrying method 'waived' was counted as Paid while a roster row
 * in exactly that state was counted as Waived. 'waived' is a reserved method
 * (see payment-methods.ts) and the dialog refuses it, but the server-side
 * schema does not, and rows predate the fixed method list.
 *
 * So the caller passes one row per line of the table — the player's fee, or
 * undefined where they have none, then the manual entries — and every line is
 * classified by the same test. The three figures then partition the table by
 * construction, for any data, which is the property the strip was implicitly
 * claiming all along.
 *
 * Outstanding is the REMAINDER rather than its own filter. A row is not-paid
 * and not-waived exactly when it is neither of the other two, and deriving it
 * is what makes the three add up even for a shape nobody anticipated (a manual
 * entry with a null paid_at, which addManualFee cannot produce but a direct
 * insert can).
 *
 * What this does NOT fix: a manual entry recorded under the name of somebody
 * who also has a roster row is two lines for one human, counted once as Paid
 * and once as Outstanding. Nothing in the data links them — that is why the
 * entry is called manual — and guessing by name would be worse than the double
 * count.
 */
export function summariseFeeCollection(rows: Array<FeeStatusRow | null | undefined>): FeeCollection {
  let paid = 0;
  let waived = 0;

  for (const row of rows) {
    if (isWaivedFee(row)) waived += 1;
    else if (row?.paid_at) paid += 1;
  }

  return { total: rows.length, paid, outstanding: rows.length - paid - waived, waived };
}

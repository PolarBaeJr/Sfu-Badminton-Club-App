// Human-readable reference numbers for the two money ledgers (migration 00077).
//
// The club owner asked for "an id, so its easier to track" — meaning something
// he can read off a receipt and match to a row, not the uuid primary key those
// rows have had since 00073. The database assigns the number (an IDENTITY
// column); this file is the ONLY place that decides how it is spelled, so the
// table, the audit trail and any future export cannot disagree about whether a
// row is EXP-7, EXP-0007 or #7.
//
// The prefix is load-bearing, not decoration: the two ledgers have independent
// sequences, so an expense and an income row will routinely share a number.
// EXP-0001 and INC-0001 are different rows, and saying "number one" out loud
// without the prefix is ambiguous — which is the exact situation this was added
// to fix.

/** Zero-padded to four so the values sort and align in a column at club scale. */
const PAD = 4;

/**
 * The database column is BIGINT and the app reads it untyped (the admin client
 * carries no generated Database type), so a null reaches here whenever a row
 * predates the migration or a query forgot the column. That is shown as an
 * em dash rather than "EXP-0000", which would be a reference number that looks
 * real and belongs to nothing.
 */
function formatRef(prefix: string, refNo: number | string | null | undefined): string {
  if (refNo === null || refNo === undefined || refNo === '') return '—';
  const n = typeof refNo === 'number' ? refNo : Number.parseInt(refNo, 10);
  if (!Number.isFinite(n)) return '—';
  // Padding is a MINIMUM, never a truncation: the ten-thousandth expense is
  // EXP-10000, not EXP-0000. String(n) already does that; padStart only ever
  // adds.
  return `${prefix}-${String(n).padStart(PAD, '0')}`;
}

/** e.g. 7 -> "EXP-0007". */
export const formatExpenseRef = (refNo: number | string | null | undefined) => formatRef('EXP', refNo);

/** e.g. 7 -> "INC-0007". */
export const formatOtherIncomeRef = (refNo: number | string | null | undefined) => formatRef('INC', refNo);

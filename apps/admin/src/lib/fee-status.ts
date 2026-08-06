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

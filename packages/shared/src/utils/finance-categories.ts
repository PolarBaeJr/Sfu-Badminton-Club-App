// Categories for the two non-fee money ledgers (migration 00073).
//
// Kept beside payment-methods.ts and for the same reason: a free-text category
// means "Shuttles", "shuttles" and "birdies" are three different things and a
// season can never be broken down by where the money went. The lists here are
// the SAME vocabulary the database CHECK constraints enforce — if one gains a
// value the other must too, or an insert the console offers will be rejected by
// the database.

export const EXPENSE_CATEGORIES = [
  // First because it is the case the club owner actually asked for.
  { value: 'shuttles', label: 'Shuttles' },
  { value: 'court_rental', label: 'Court rental' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'food', label: 'Food' },
  { value: 'other', label: 'Other' },
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]['value'];

export const EXPENSE_CATEGORY_VALUES = EXPENSE_CATEGORIES.map((c) => c.value) as readonly ExpenseCategory[];

export const OTHER_INCOME_CATEGORIES = [
  { value: 'donation', label: 'Donation' },
  { value: 'grant', label: 'Grant' },
  { value: 'fundraiser', label: 'Fundraiser' },
  { value: 'social', label: 'Social' },
  { value: 'sponsorship', label: 'Sponsorship' },
  { value: 'other', label: 'Other' },
] as const;

export type OtherIncomeCategory = (typeof OTHER_INCOME_CATEGORIES)[number]['value'];

export const OTHER_INCOME_CATEGORY_VALUES = OTHER_INCOME_CATEGORIES.map((c) => c.value) as readonly OtherIncomeCategory[];

/**
 * Stored value -> something readable.
 *
 * Falls back to the raw value rather than to "Other". A row written before a
 * category was renamed must still show what it says, and quietly relabelling an
 * unknown category as Other would hide it inside a bucket it is not in.
 */
export function formatExpenseCategory(stored: string | null | undefined): string {
  if (!stored) return '';
  return EXPENSE_CATEGORIES.find((c) => c.value === stored)?.label ?? stored;
}

export function formatOtherIncomeCategory(stored: string | null | undefined): string {
  if (!stored) return '';
  return OTHER_INCOME_CATEGORIES.find((c) => c.value === stored)?.label ?? stored;
}

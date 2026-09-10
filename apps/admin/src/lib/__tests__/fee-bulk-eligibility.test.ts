import { describe, it, expect } from 'vitest';
import { countEligible, type FeeRowState } from '../fee-bulk-eligibility';

// Which of a selection a fee button will really act on.
//
// THE THING THIS PROTECTS is a number in a confirm dialog. One fee page has one
// selection and three buttons with three different eligible states, so "9
// members" over an action that will touch 4 of them is a figure the officer
// cannot check, and a button that looks live over a selection none of it applies
// to is a click that can only produce a page of refusals.
//
// IT IS NOT A FILTER, which is the other half and cannot be tested here because
// the absence of a call is not a value: the bars send every selected id and let
// the server refuse per record. The module says why at length.

const STATES: Record<string, FeeRowState> = {
  ada: 'unpaid',
  bao: 'paid',
  kiera: 'waived',
};

describe('counting what an action applies to', () => {
  it('counts only the unpaid rows for Mark Paid and for Waive', () => {
    // Both are refused over a row that already carries a paid_at, waiver
    // included: recording a payment over a waiver replaces the club's decision
    // not to charge, and re-waiving rewrites who waived it and when.
    const ids = ['ada', 'bao', 'kiera'];
    expect(countEligible(ids, STATES, 'markPaid')).toBe(1);
    expect(countEligible(ids, STATES, 'waive')).toBe(1);
  });

  it('counts both the paid and the waived rows for Mark Unpaid', () => {
    // One control, two reversals: the page renders it as "Mark Unpaid" over a
    // paid row and "Unwaive" over a waived one.
    expect(countEligible(['ada', 'bao', 'kiera'], STATES, 'markUnpaid')).toBe(2);
  });

  it('is zero when none of the selection applies, which is what greys the button out', () => {
    expect(countEligible(['bao', 'kiera'], STATES, 'markPaid')).toBe(0);
    expect(countEligible(['ada'], STATES, 'markUnpaid')).toBe(0);
  });

  it('counts an id the map does not know as eligible', () => {
    // ABSENT IS NOT INELIGIBLE. The map is one server render; a row the page no
    // longer holds, or one added since, is a row it has no opinion about, and
    // reading silence as "no" would grey out a button over rows that are
    // perfectly actionable. The server is what decides, per record.
    expect(countEligible(['ada', 'nobody-knows'], STATES, 'markPaid')).toBe(2);
    expect(countEligible(['nobody-knows'], STATES, 'markUnpaid')).toBe(1);
  });

  it('is zero for an empty selection', () => {
    expect(countEligible([], STATES, 'markPaid')).toBe(0);
  });
});

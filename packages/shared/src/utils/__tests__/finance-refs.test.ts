import { describe, it, expect } from 'vitest';
import { formatExpenseRef, formatOtherIncomeRef } from '../finance-refs';

// The reference number the club owner asked for ("give each expense an 'id',
// so its easier to track"). It is read off a receipt and matched to a row by a
// person, so the ways it can go wrong are all ways a person ends up looking at
// the wrong row — or at a row that does not exist.

describe('formatExpenseRef / formatOtherIncomeRef', () => {
  it('pads to a fixed width so a column of them lines up', () => {
    expect(formatExpenseRef(1)).toBe('EXP-0001');
    expect(formatExpenseRef(42)).toBe('EXP-0042');
    expect(formatOtherIncomeRef(1)).toBe('INC-0001');
  });

  // The prefix is not decoration. The two ledgers have independent sequences,
  // so an expense and an income row WILL share a number — saying "number one"
  // without the prefix names two different rows.
  it('keeps the two ledgers apart at the same number', () => {
    expect(formatExpenseRef(1)).not.toBe(formatOtherIncomeRef(1));
  });

  // Padding is a minimum, never a truncation. Wrapping at four digits would
  // make EXP-0001 name two rows years apart, which is the one thing an
  // identifier may not do.
  it('grows past the padding rather than wrapping', () => {
    expect(formatExpenseRef(10000)).toBe('EXP-10000');
    expect(formatExpenseRef(123456)).toBe('EXP-123456');
  });

  // The admin client carries no generated Database type, so the column arrives
  // untyped and a query that forgot to select it yields undefined. Rendering
  // "EXP-0000" would be a reference that looks real and belongs to nothing;
  // an em dash is visibly absent.
  it('shows nothing rather than a plausible-looking fake', () => {
    expect(formatExpenseRef(null)).toBe('—');
    expect(formatExpenseRef(undefined)).toBe('—');
    expect(formatExpenseRef('')).toBe('—');
    expect(formatExpenseRef('not a number')).toBe('—');
  });

  // BIGINT comes back from PostgREST as a string once it exceeds the safe
  // integer range, and as a string in some client configurations regardless.
  it('accepts the string form the database can return', () => {
    expect(formatExpenseRef('7')).toBe('EXP-0007');
  });
});

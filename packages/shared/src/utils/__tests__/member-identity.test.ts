import { describe, it, expect } from 'vitest';
import {
  normalizeHandle,
  handleError,
  isHandleTakenError,
  formatMemberNumber,
  deriveHandleBase,
  deriveHandle,
  RESERVED_HANDLES,
} from '../member-identity';

// The shape expectations here are the ones players_handle_shape_check enforces
// in 00092 — keep them in step with the migration.

describe('normalizeHandle', () => {
  it('folds case rather than rejecting it', () => {
    expect(normalizeHandle('Kiera')).toBe('kiera');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeHandle('  kiera  ')).toBe('kiera');
  });

  it('reads blank and whitespace-only as no handle at all', () => {
    expect(normalizeHandle('')).toBeNull();
    expect(normalizeHandle('   ')).toBeNull();
    expect(normalizeHandle(null)).toBeNull();
    expect(normalizeHandle(undefined)).toBeNull();
  });
});

describe('handleError', () => {
  it('accepts a plain handle', () => {
    expect(handleError('kiera')).toBeNull();
  });

  it('accepts digits and underscores after the first letter', () => {
    expect(handleError('k_1era_9')).toBeNull();
  });

  it('accepts no handle — the state every member starts in', () => {
    expect(handleError(null)).toBeNull();
  });

  it('rejects the length bounds from either side', () => {
    expect(handleError('ab')).toMatch(/3–20/);
    expect(handleError('a'.repeat(21))).toMatch(/3–20/);
    expect(handleError('abc')).toBeNull();
    expect(handleError('a'.repeat(20))).toBeNull();
  });

  it('rejects a handle that does not start with a letter', () => {
    expect(handleError('1kiera')).toMatch(/start with a letter/);
    expect(handleError('_kiera')).toMatch(/start with a letter/);
  });

  it('rejects characters outside [a-z0-9_]', () => {
    expect(handleError('kiera!')).toMatch(/start with a letter/);
    expect(handleError('kiera chan')).toMatch(/start with a letter/);
    expect(handleError('kiera-chan')).toMatch(/start with a letter/);
  });

  // Mixed case reaches this function only if a caller skipped normalizeHandle,
  // and the answer has to be "no" rather than a silent accept — the database
  // CHECK refuses it too.
  it('rejects an un-normalized handle', () => {
    expect(handleError('Kiera')).not.toBeNull();
  });

  // Every reserved name is refused; `me` is refused by the length rule before
  // the list is ever consulted, which is why this asserts "rejected" rather
  // than a particular sentence.
  it('rejects every reserved name', () => {
    for (const reserved of RESERVED_HANDLES) {
      expect(handleError(reserved)).not.toBeNull();
    }
    expect(handleError('admin')).toBe('That handle is reserved.');
  });
});

describe('isHandleTakenError', () => {
  it('recognises the handle index', () => {
    expect(
      isHandleTakenError({
        code: '23505',
        message: 'duplicate key value violates unique constraint "players_handle_lower_idx"',
      }),
    ).toBe(true);
  });

  it('leaves the email uniqueness violation alone', () => {
    expect(
      isHandleTakenError({
        code: '23505',
        message: 'duplicate key value violates unique constraint "players_email_lower_key"',
      }),
    ).toBe(false);
  });

  it('is false for anything that is not a unique violation', () => {
    expect(isHandleTakenError({ code: '23514', message: 'players_handle_lower_idx' })).toBe(false);
    expect(isHandleTakenError(null)).toBe(false);
    expect(isHandleTakenError(undefined)).toBe(false);
  });
});

describe('formatMemberNumber', () => {
  it('zero-pads to four', () => {
    expect(formatMemberNumber(42)).toBe('#0042');
    expect(formatMemberNumber(1)).toBe('#0001');
    expect(formatMemberNumber(9999)).toBe('#9999');
  });

  it('grows rather than truncating past four digits', () => {
    expect(formatMemberNumber(10000)).toBe('#10000');
  });

  it('returns null for a member who has not been assigned one', () => {
    expect(formatMemberNumber(null)).toBeNull();
    expect(formatMemberNumber(undefined)).toBeNull();
  });
});

// The backfill in 00092. These expectations are what that migration's SQL
// produces for the same inputs — keep them in step with it, the way
// name.test.ts is kept in step with 00023.

describe('deriveHandleBase', () => {
  it('lowercases and joins the words of a name', () => {
    expect(deriveHandleBase('Umar Ueda')).toBe('umar_ueda');
  });

  it('collapses punctuation runs, and underscores that were already there', () => {
    expect(deriveHandleBase('Matt  (the tall one)')).toBe('matt_the_tall_one');
    expect(deriveHandleBase('a__b')).toBe('a_b');
  });

  it('drops leading non-letters, because a handle must start with one', () => {
    expect(deriveHandleBase('123abc')).toBe('abc');
    expect(deriveHandleBase('_kiera')).toBe('kiera');
  });

  it('truncates to 20 and does not leave the cut underscore behind', () => {
    expect(deriveHandleBase('Konstantinos Papadopoulos')).toBe('konstantinos_papadop');
    // The 20th character is the separator; it goes with the truncation.
    expect(deriveHandleBase('abcdefghijklmnopqrs tuv')).toBe('abcdefghijklmnopqrs');
  });

  it('yields nothing usable for text that is only punctuation or emoji', () => {
    expect(deriveHandleBase('🎉')).toBe('');
    expect(deriveHandleBase('!!!')).toBe('');
    expect(deriveHandleBase('')).toBe('');
    expect(deriveHandleBase(null)).toBe('');
  });
});

describe('deriveHandle', () => {
  const free = () => false;

  // THE CASE THAT WAS SILENTLY WRONG. Most of the club never set a nickname, so
  // a ladder that consults display_name and then gives up hands them all a
  // number — 86 of 99 on staging.
  it('falls to the full name when there is no nickname', () => {
    expect(
      deriveHandle({ displayName: '', fullName: 'Umar Ueda', memberNumber: 14, isTaken: free }),
    ).toBe('umar_ueda');
    expect(
      deriveHandle({ displayName: null, fullName: 'Nadia Okafor', memberNumber: 15, isTaken: free }),
    ).toBe('nadia_okafor');
  });

  it('prefers the nickname the member chose', () => {
    expect(
      deriveHandle({ displayName: 'Danny', fullName: 'Daniel Fitzgerald', memberNumber: 3, isTaken: free }),
    ).toBe('danny');
  });

  // The second Matthew. Better than matthew_6, which is what the nickname-only
  // ladder produced on staging.
  it('gives a taken nickname holder their full name rather than a number', () => {
    expect(
      deriveHandle({
        displayName: 'Matthew',
        fullName: 'Matthew Cheng',
        memberNumber: 6,
        isTaken: (c) => c === 'matthew',
      }),
    ).toBe('matthew_cheng');
  });

  it('appends the member number when both names are taken', () => {
    expect(
      deriveHandle({
        displayName: 'Matthew',
        fullName: 'Matthew Cheng',
        memberNumber: 6,
        isTaken: (c) => c === 'matthew' || c === 'matthew_cheng',
      }),
    ).toBe('matthew_6');
  });

  it('numbers the nickname base, not the longer one, when a nickname exists', () => {
    expect(
      deriveHandle({
        displayName: 'Bianca',
        fullName: 'Bianca Rodrigues',
        memberNumber: 17,
        isTaken: (c) => c === 'bianca' || c === 'bianca_rodrigues',
      }),
    ).toBe('bianca_17');
  });

  it('numbers the full name when that is the only base there is', () => {
    expect(
      deriveHandle({
        displayName: '',
        fullName: 'Umar Ueda',
        memberNumber: 14,
        isTaken: (c) => c === 'umar_ueda',
      }),
    ).toBe('umar_ueda_14');
  });

  it('truncates the base to make room for the number', () => {
    const handle = deriveHandle({
      displayName: '',
      fullName: 'Konstantinos Papadopoulos',
      memberNumber: 123,
      isTaken: (c) => c === 'konstantinos_papadop',
    });
    expect(handle).toBe('konstantinos_pap_123');
    expect(handle.length).toBe(20);
  });

  // Only reachable by a member with no usable text in EITHER name. After the
  // full-name tier that should be nobody, which is the point.
  it('falls back to the number alone when neither name yields anything', () => {
    expect(
      deriveHandle({ displayName: '🎉', fullName: '', memberNumber: 42, isTaken: free }),
    ).toBe('member_0042');
  });

  it('skips a reserved name and takes the next tier', () => {
    expect(
      deriveHandle({ displayName: 'Admin', fullName: 'Ada Minelli', memberNumber: 9, isTaken: free }),
    ).toBe('ada_minelli');
  });

  it('skips a base too short to be a handle', () => {
    expect(
      deriveHandle({ displayName: 'Jo', fullName: 'Jo Park', memberNumber: 5, isTaken: free }),
    ).toBe('jo_park');
  });

  it('throws rather than leaving a member with no handle', () => {
    expect(() =>
      deriveHandle({ displayName: 'Kiera', fullName: 'Kiera Watanabe', memberNumber: 1, isTaken: () => true }),
    ).toThrow(/member #1/);
  });
});

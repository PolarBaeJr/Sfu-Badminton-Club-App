import { describe, it, expect } from 'vitest';
import {
  normalizeHandle,
  handleError,
  isHandleTakenError,
  formatMemberNumber,
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

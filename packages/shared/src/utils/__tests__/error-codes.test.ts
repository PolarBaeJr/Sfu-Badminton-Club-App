import { describe, it, expect } from 'vitest';
import {
  ERROR_AREAS,
  ERROR_CODES,
  ERROR_CODE_PATTERN,
  describeError,
  errorToastText,
  formatDigest,
  isGenericServerMessage,
  makeErrorRef,
  parseErrorDigest,
  type ErrorCodeEntry,
} from '../error-codes';

const GENERIC =
  'An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.';

const entries = Object.entries(ERROR_CODES) as [string, ErrorCodeEntry][];

// Digests Next gives meaning to. A code starting with any of these would be
// read as Next's own control flow (a redirect, a 404) instead of an error.
const NEXT_RESERVED_DIGEST_PREFIXES = [
  'NEXT_',
  'DYNAMIC_SERVER_USAGE',
  'BAILOUT_TO_CLIENT_SIDE_RENDERING',
  'HANGING_PROMISE_REJECTION',
];

// Surrogate-pair emoji and the pictographic block; the registry ships to users.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

describe('the registry', () => {
  it('uses AREA-NNN for every code, with the prefix naming its own area', () => {
    for (const [code, entry] of entries) {
      expect(code).toMatch(ERROR_CODE_PATTERN);
      expect(code.split('-')[0]).toBe(entry.area);
    }
  });

  it('gives every area a -000', () => {
    for (const area of ERROR_AREAS) expect(ERROR_CODES).toHaveProperty(`${area}-000`);
  });

  it('has no area starting with E, which Next reads as its own error code', () => {
    for (const area of ERROR_AREAS) expect(area.startsWith('E')).toBe(false);
  });

  it('has no code that Next would read as control flow', () => {
    for (const [code] of entries) {
      for (const prefix of NEXT_RESERVED_DIGEST_PREFIXES) expect(code.startsWith(prefix)).toBe(false);
      expect(code).not.toMatch(/[@;]/);
    }
  });

  it('writes no em dash and no emoji', () => {
    for (const [, entry] of entries) {
      for (const text of [entry.title, entry.meaning, entry.cause]) {
        expect(text).not.toContain('\u2014');
        expect(text).not.toMatch(EMOJI);
        expect(text).not.toContain('|');
      }
    }
  });
});

describe('makeErrorRef', () => {
  it('is 8 lowercase base36 characters and differs per call', () => {
    const a = makeErrorRef();
    expect(a).toMatch(/^[a-z0-9]{8}$/);
    expect(makeErrorRef()).not.toBe(a);
  });
});

describe('parseErrorDigest', () => {
  it('round-trips a coded digest', () => {
    const ref = makeErrorRef();
    expect(parseErrorDigest(formatDigest('DB-101', ref), 'FEE')).toEqual({ code: 'DB-101', ref, known: true });
  });

  it("strips Next's @E suffix", () => {
    expect(parseErrorDigest('FEE-101.k3x9q2ab@E123', 'GEN')).toEqual({
      code: 'FEE-101',
      ref: 'k3x9q2ab',
      known: true,
    });
  });

  it("names a numeric digest after the boundary's area", () => {
    expect(parseErrorDigest('931992559', 'FEE')).toEqual({ code: 'FEE-000', ref: '931992559', known: true });
    expect(parseErrorDigest('931992559')).toEqual({ code: 'GEN-000', ref: '931992559', known: true });
  });

  it('keeps an unknown but well-formed code verbatim', () => {
    expect(parseErrorDigest('FEE-999.abc', 'GEN')).toEqual({ code: 'FEE-999', ref: 'abc', known: false });
  });
});

describe('isGenericServerMessage', () => {
  it("matches Next's production text only", () => {
    expect(isGenericServerMessage(GENERIC)).toBe(true);
    expect(isGenericServerMessage('Failed to load fees')).toBe(false);
    expect(isGenericServerMessage(undefined)).toBe(false);
  });
});

describe('describeError', () => {
  it('keeps a client error message and has no code', () => {
    expect(describeError(new Error('Network down'), 'FEE', 'Failed.')).toEqual({
      message: 'Network down',
      code: null,
      ref: null,
      entry: null,
      copyText: null,
    });
  });

  it('uses the fallback for the generic text or an empty message', () => {
    expect(describeError(new Error(GENERIC), 'GEN', 'Failed.').message).toBe('Failed.');
    expect(describeError(new Error(''), 'GEN', 'Failed.').message).toBe('Failed.');
  });

  it('describes a coded server error', () => {
    const d = describeError({ message: GENERIC, digest: 'DB-101.k3x9q2ab' }, 'FEE', 'Failed.');
    expect(d.message).toBe('Failed.');
    expect(d.code).toBe('DB-101');
    expect(d.ref).toBe('k3x9q2ab');
    expect(d.entry).toBe(ERROR_CODES['DB-101']);
    expect(d.copyText).toBe('DB-101.k3x9q2ab');
  });
});

describe('errorToastText', () => {
  it('shows the fallback and the code for a coded digest', () => {
    const err = Object.assign(new Error(GENERIC), { digest: 'FEE-102.abcd1234' });
    expect(errorToastText(err, 'FEE', 'Failed to confirm')).toBe('Failed to confirm (FEE-102.abcd1234)');
  });

  it("shows the fallback and an area code for Next's generic text", () => {
    const err = Object.assign(new Error(GENERIC), { digest: '931992559' });
    expect(errorToastText(err, 'FEE', 'Failed to confirm')).toBe('Failed to confirm (FEE-000.931992559)');
    expect(errorToastText(new Error(GENERIC), 'FEE', 'Failed to confirm')).toBe('Failed to confirm');
  });

  it("keeps an ordinary message, and falls back for something that is not an Error", () => {
    expect(errorToastText(new Error('Amount must be positive'), 'FEE', 'Failed')).toBe('Amount must be positive');
    expect(errorToastText('nope', 'FEE', 'Failed')).toBe('Failed');
  });
});

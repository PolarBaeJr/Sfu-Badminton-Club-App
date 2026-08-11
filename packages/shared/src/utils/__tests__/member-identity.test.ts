import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  normalizeHandle,
  handleError,
  isHandleTakenError,
  formatMemberCode,
  isMemberCode,
  deriveMemberCode,
  deriveHandleBase,
  deriveHandle,
  MEMBER_CODE_ALPHABET,
  MEMBER_CODE_LENGTH,
  RESERVED_HANDLES,
} from '../member-identity';

// The md5 the SQL uses. Postgres' md5(text) hashes the UTF-8 bytes and returns
// lowercase hex, which is exactly what this returns — so a vector that holds
// here holds in the database, provided the fold and the base-30 walk agree.
const md5 = (text: string) => createHash('md5').update(text, 'utf8').digest('hex');

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

describe('formatMemberCode', () => {
  it('uppercases, because a code is read aloud and typed rather than sorted', () => {
    expect(formatMemberCode('k3f9tq2')).toBe('K3F9TQ2');
    expect(formatMemberCode('K3F9TQ2')).toBe('K3F9TQ2');
  });

  it('does not pad — padding would invent characters the code does not have', () => {
    expect(formatMemberCode('K3F9TQ2')).toHaveLength(MEMBER_CODE_LENGTH);
    expect(formatMemberCode('K3F9TQ2')).not.toMatch(/^0+/);
  });

  it('carries no # — that means "number", and this is not one', () => {
    expect(formatMemberCode('K3F9TQ2')).not.toContain('#');
  });

  it('returns null for a member who has not been assigned one', () => {
    expect(formatMemberCode(null)).toBeNull();
    expect(formatMemberCode(undefined)).toBeNull();
    expect(formatMemberCode('')).toBeNull();
    expect(formatMemberCode('   ')).toBeNull();
  });
});

describe('isMemberCode', () => {
  it('accepts a well-formed code', () => {
    expect(isMemberCode('K3F9TQ2')).toBe(true);
  });

  it('refuses the ambiguous characters the alphabet drops', () => {
    for (const bad of ['0', 'O', '1', 'I', 'L', 'U']) {
      expect(isMemberCode(`${bad}AAAAAA`)).toBe(false);
    }
  });

  it('refuses lowercase — there is exactly one legal spelling', () => {
    expect(isMemberCode('k3f9tq2')).toBe(false);
  });

  it('refuses anything that is not exactly seven characters', () => {
    expect(isMemberCode('K3F9TQ')).toBe(false);
    expect(isMemberCode('K3F9TQ22')).toBe(false);
    expect(isMemberCode(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The member code generator. This mirrors derive_member_code() in 00092 and the
// whole point of the mirror is that a test can hold it to the SQL's answer.
// ---------------------------------------------------------------------------

describe('deriveMemberCode', () => {
  const free = () => false;
  const code = (playerId: string, isTaken: (c: string) => boolean = free) =>
    deriveMemberCode({ playerId, md5, isTaken });

  // THE VECTORS THAT PIN THE MIRROR TO THE DATABASE. Every other test in this
  // block would still pass if the base-30 digits came out reversed, or if the
  // division stopped truncating — those produce codes that are still 7
  // characters, still in the alphabet and still deterministic, and agree with
  // Postgres about nothing.
  //
  // 00092 carries these same five pairs in a comment with the SELECT that
  // checks them. If one of these ever fails, the two implementations have
  // drifted and the database is the one that is right.
  it('produces the exact codes 00092 produces for the same ids', () => {
    expect(code('00000000-0000-0000-0000-000000000000')).toBe('BY227EV');
    expect(code('11111111-2222-3333-4444-555555555555')).toBe('Y3WMYFY');
    expect(code('a3f1c2d4-5e6b-7a8c-9d0e-1f2a3b4c5d6e')).toBe('32Y8FW7');
    expect(code('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe('KNNHEM8');
    expect(code('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('ED6NARH');
  });

  // The requirement the whole design turns on. A random code would give a
  // member a different identity on every run of a re-runnable migration.
  it('is deterministic: the same id gives the same code, every time', () => {
    const id = 'a3f1c2d4-5e6b-7a8c-9d0e-1f2a3b4c5d6e';
    const first = code(id);
    for (let i = 0; i < 100; i++) expect(code(id)).toBe(first);
  });

  it('gives different ids different codes', () => {
    expect(code('00000000-0000-0000-0000-000000000000')).not.toBe(
      code('00000000-0000-0000-0000-000000000001'),
    );
  });

  it('is exactly seven characters, all of them in the alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const c = code(syntheticId(i));
      expect(c).toHaveLength(MEMBER_CODE_LENGTH);
      expect(isMemberCode(c)).toBe(true);
    }
  });

  // The characters that cannot be told apart when a code is read out at the
  // door or typed off a phone. Asserted over real output rather than over the
  // alphabet constant, because the constant is not what a member sees.
  it('never emits 0, O, 1, I, L or U', () => {
    for (let i = 0; i < 2000; i++) {
      expect(code(syntheticId(i))).not.toMatch(/[0O1ILU]/);
    }
  });

  it('excludes them from the alphabet itself too', () => {
    expect(MEMBER_CODE_ALPHABET).not.toMatch(/[0O1ILU]/);
    expect(MEMBER_CODE_ALPHABET).toHaveLength(30);
    expect(new Set(MEMBER_CODE_ALPHABET).size).toBe(30);
  });

  // MEASURED, NOT ASSUMED. 30^7 is 21.87 billion, so the birthday expectation
  // over 5,000 ids is about 0.0006 collisions — this asserts zero because that
  // is what a fixed corpus of 5,000 actually produces, and a regression that
  // shrank the effective space (folding 32 bits, or a stuck digit) would show
  // up here as duplicates long before it showed up in a club of 99.
  it('produces 5,000 distinct codes from 5,000 ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(code(syntheticId(i)));
    expect(seen.size).toBe(5000);
  });

  // A stuck or under-used digit is the other way the space quietly shrinks. All
  // thirty characters should appear, and no character should be wildly over- or
  // under-represented: 5,000 codes is 35,000 characters, so ~1,167 each. The
  // ±25% band is loose enough not to be flaky and tight enough to catch a
  // modulo that never reaches the top of the alphabet.
  it('spreads across the whole alphabet', () => {
    const counts = new Map<string, number>();
    const n = 5000;
    for (let i = 0; i < n; i++) {
      for (const ch of code(syntheticId(i))) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(counts.size).toBe(30);
    const expected = (n * MEMBER_CODE_LENGTH) / 30;
    for (const [, seen] of counts) {
      expect(seen).toBeGreaterThan(expected * 0.75);
      expect(seen).toBeLessThan(expected * 1.25);
    }
  });

  // WHAT HAPPENS ON A COLLISION. The code is rehashed with an attempt counter,
  // not incremented: 'id:1' lands somewhere unrelated, where id + 1 would walk
  // into whatever sits next to it in the alphabet.
  it('rehashes past a taken code rather than stepping to the neighbouring one', () => {
    const id = '00000000-0000-0000-0000-000000000000';
    const taken = code(id);
    expect(taken).toBe('BY227EV');

    const next = code(id, (c) => c === taken);
    expect(next).toBe('KHC8WSN');
    expect(next).not.toBe(taken);
    // Not an increment. The last character moved by more than one step, which
    // an incrementing scheme could not do.
    expect(next.slice(0, 6)).not.toBe(taken.slice(0, 6));
  });

  it('keeps rehashing, deterministically, while codes stay taken', () => {
    const id = 'a3f1c2d4-5e6b-7a8c-9d0e-1f2a3b4c5d6e';
    const blocked = new Set([code(id)]);
    blocked.add(code(id, (c) => blocked.has(c)));
    const third = code(id, (c) => blocked.has(c));
    expect(blocked.has(third)).toBe(false);
    // Same inputs, same answer — the ladder is as deterministic as the first
    // rung of it.
    expect(code(id, (c) => blocked.has(c))).toBe(third);
  });

  it('gives up loudly rather than looping forever when nothing is free', () => {
    expect(() =>
      deriveMemberCode({
        playerId: '00000000-0000-0000-0000-000000000000',
        md5,
        isTaken: () => true,
        maxAttempts: 20,
      }),
    ).toThrow(/Could not derive a free member code/);
  });
});

/** A stable, well-formed synthetic UUID for the distribution checks above. */
function syntheticId(i: number): string {
  const h = md5(`synthetic:${i}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

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

  // THE CASE THAT WAS SILENTLY WRONG, AND THE REGRESSION PIN FOR IT. Most of
  // the club never set a nickname, so a ladder that consults display_name and
  // then gives up hands them all a fallback — 86 of 99 on staging. These two
  // assertions are what says the full_name tier is still ahead of every
  // fallback; they must keep passing through any change to the tiers below.
  it('falls to the full name when there is no nickname', () => {
    expect(
      deriveHandle({ displayName: '', fullName: 'Umar Ueda', memberCode: 'K3F9TQ2', isTaken: free }),
    ).toBe('umar_ueda');
    expect(
      deriveHandle({ displayName: null, fullName: 'Nadia Okafor', memberCode: 'BY227EV', isTaken: free }),
    ).toBe('nadia_okafor');
  });

  it('prefers the nickname the member chose', () => {
    expect(
      deriveHandle({ displayName: 'Danny', fullName: 'Daniel Fitzgerald', memberCode: 'ED6NARH', isTaken: free }),
    ).toBe('danny');
  });

  // The second Matthew. Better than a suffix, which is what the nickname-only
  // ladder produced on staging.
  it('gives a taken nickname holder their full name rather than a suffix', () => {
    expect(
      deriveHandle({
        displayName: 'Matthew',
        fullName: 'Matthew Cheng',
        memberCode: 'Y3WMYFY',
        isTaken: (c) => c === 'matthew',
      }),
    ).toBe('matthew_cheng');
  });

  // THE DECOUPLING. The suffix is a counter and NOT the member code: it used to
  // be the member number, and with a code that spelling would be
  // `matthew_y3wmyfy`. A counter also means the handle scheme stops moving when
  // the identifier scheme does — which is the property that keeps a public
  // `@handle` from silently changing under somebody.
  it('appends a plain counter when both names are taken, never the member code', () => {
    const handle = deriveHandle({
      displayName: 'Matthew',
      fullName: 'Matthew Cheng',
      memberCode: 'Y3WMYFY',
      isTaken: (c) => c === 'matthew' || c === 'matthew_cheng',
    });
    expect(handle).toBe('matthew_2');
    expect(handle).not.toContain('y3wmyfy');
  });

  it('walks the counter up to the first free one', () => {
    expect(
      deriveHandle({
        displayName: 'Matthew',
        fullName: 'Matthew Cheng',
        memberCode: 'Y3WMYFY',
        isTaken: (c) => ['matthew', 'matthew_cheng', 'matthew_2', 'matthew_3'].includes(c),
      }),
    ).toBe('matthew_4');
  });

  it('suffixes the nickname base, not the longer one, when a nickname exists', () => {
    expect(
      deriveHandle({
        displayName: 'Bianca',
        fullName: 'Bianca Rodrigues',
        memberCode: '32Y8FW7',
        isTaken: (c) => c === 'bianca' || c === 'bianca_rodrigues',
      }),
    ).toBe('bianca_2');
  });

  it('suffixes the full name when that is the only base there is', () => {
    expect(
      deriveHandle({
        displayName: '',
        fullName: 'Umar Ueda',
        memberCode: 'K3F9TQ2',
        isTaken: (c) => c === 'umar_ueda',
      }),
    ).toBe('umar_ueda_2');
  });

  it('truncates the base to make room for the suffix', () => {
    const handle = deriveHandle({
      displayName: '',
      fullName: 'Konstantinos Papadopoulos',
      memberCode: 'KNNHEM8',
      isTaken: (c) => c === 'konstantinos_papadop',
    });
    expect(handle).toBe('konstantinos_papad_2');
    expect(handle.length).toBe(20);
  });

  // Only reachable by a member with no usable text in EITHER name. After the
  // full-name tier that should be nobody, which is the point.
  it('falls back to the member code when neither name yields anything', () => {
    expect(
      deriveHandle({ displayName: '🎉', fullName: '', memberCode: 'K3F9TQ2', isTaken: free }),
    ).toBe('member_k3f9tq2');
  });

  it('skips a reserved name and takes the next tier', () => {
    expect(
      deriveHandle({ displayName: 'Admin', fullName: 'Ada Minelli', memberCode: 'ED6NARH', isTaken: free }),
    ).toBe('ada_minelli');
  });

  it('skips a base too short to be a handle', () => {
    expect(
      deriveHandle({ displayName: 'Jo', fullName: 'Jo Park', memberCode: 'BY227EV', isTaken: free }),
    ).toBe('jo_park');
  });

  it('throws rather than leaving a member with no handle', () => {
    expect(() =>
      deriveHandle({ displayName: 'Kiera', fullName: 'Kiera Watanabe', memberCode: 'K3F9TQ2', isTaken: () => true }),
    ).toThrow(/member K3F9TQ2/);
  });
});

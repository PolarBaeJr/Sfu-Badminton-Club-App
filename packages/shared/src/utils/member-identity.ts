// The two public identifiers a member carries besides their name.
//
//   handle       a username the member picks and may change. Nullable, and
//                NULL for every member who has not chosen one — which is all
//                of them on the day this ships.
//   member_code  seven characters — K3F9TQ2 — the club assigns once and never
//                reuses. Nobody types it; it is stamped when a person becomes a
//                member. Deliberately NOT a university student number — no SFU
//                data is stored anywhere near it — and deliberately not
//                sequential either: a counter would publish join order, which
//                is a fact about a person the club never decided to share.
//
// Pure on purpose. The handle rules are enforced in a server action, the
// database CHECK and the settings form, and all three have to agree; a plain
// function is the only version of "agree" that can be checked without a
// database or a browser.

/** 3–20 characters, lowercase letters/digits/underscore, first character a letter. */
export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 20;

// The same shape as the players_handle_shape_check CHECK in 00092. Kept in step
// with it by hand: the database is the one that cannot be got around, this is
// the one that produces a sentence a person can act on.
const HANDLE_PATTERN = /^[a-z][a-z0-9_]*$/;

// Names that must not end up next to somebody's photo as `@admin`. These are
// display names on a public profile, so the objection is impersonation rather
// than routing — none of these is a URL segment today, and the list would still
// be needed if they never became one.
export const RESERVED_HANDLES: readonly string[] = [
  'admin',
  'exec',
  'root',
  'me',
  'settings',
  'api',
  'support',
  'sfu',
  'club',
];

/**
 * What actually gets stored. Trimmed and folded to lowercase rather than
 * rejected for capitals — someone typing `Kiera` meant `kiera`, and refusing it
 * teaches them nothing. Blank comes back as null so clearing the field empties
 * the column instead of storing ''.
 */
export function normalizeHandle(input: string | null | undefined): string | null {
  const trimmed = (input ?? '').trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * Why this handle cannot be used, or null if it can. Expects the NORMALIZED
 * value — case folding happens before the rules, never as one of them.
 *
 * null (no handle) is valid: it is the state every member is in until they pick
 * one, and the settings form has to be able to save the rest of the profile
 * without one.
 */
export function handleError(handle: string | null): string | null {
  if (handle === null) return null;
  if (handle.length < HANDLE_MIN_LENGTH || handle.length > HANDLE_MAX_LENGTH) {
    return `Handles are ${HANDLE_MIN_LENGTH}–${HANDLE_MAX_LENGTH} characters.`;
  }
  if (!HANDLE_PATTERN.test(handle)) {
    return 'Handles can use letters, numbers and underscores, and must start with a letter.';
  }
  if (RESERVED_HANDLES.includes(handle)) return 'That handle is reserved.';
  return null;
}

/** Shown when the unique index refuses a handle somebody else already holds. */
export const HANDLE_TAKEN_MESSAGE = 'That handle is taken.';

// Two people can claim the same handle in the same second, so the check that
// decides it is the unique index — never a read followed by a write. This turns
// the resulting constraint violation into the sentence above.
//
// Keyed on the index name as well as the code: 23505 is every unique violation
// on the table, and players_email_lower_key is one of them. Reporting "that
// handle is taken" for a duplicate email would be a lie in the one place a
// member has no way to check.
export function isHandleTakenError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  const message = error.message ?? '';
  return error.code === '23505' && message.includes('players_handle_lower_idx');
}

/**
 * The four normalizing steps 00092 applies to a name before it can be a handle:
 * lowercase, every run outside [a-z0-9_] to a single '_', '_' runs collapsed,
 * leading non-letters dropped, truncated to 20, trailing '_' dropped.
 *
 * Returns '' when the text yields nothing usable — a blank name, punctuation
 * only, emoji only. That is a real answer, not a failure: it is what sends a
 * member down to the next tier.
 */
export function deriveHandleBase(source: string | null | undefined): string {
  let base = (source ?? '').toLowerCase();
  base = base.replace(/[^a-z0-9_]+/g, '_');
  // A second collapse, for underscores that were already in the text: the pass
  // above only collapses runs of the characters it is replacing.
  base = base.replace(/_+/g, '_');
  base = base.replace(/^[^a-z]+/, '');
  base = base.slice(0, HANDLE_MAX_LENGTH);
  return base.replace(/_+$/, '');
}

// ---------------------------------------------------------------------------
// The member code
// ---------------------------------------------------------------------------

/**
 * THE ALPHABET IS PART OF THE CONTRACT, not a formatting detail. A member code
 * gets read aloud at the door and typed off a phone screen, so the characters
 * that cannot be told apart in those two situations are simply not in it: 0/O
 * and 1/I/L are gone, and U goes too — Crockford drops it, and it is what keeps
 * a seven-character string from occasionally spelling something the club would
 * have to apologise for. Thirty characters left.
 *
 * KEPT IN STEP BY HAND with v_alphabet in derive_member_code() and with the
 * players_member_code_shape_check CHECK, both in 00092. The database is the one
 * that cannot be got around; this is the one that can be tested.
 */
export const MEMBER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Seven characters. 30^7 = 21,870,000,000 codes. */
export const MEMBER_CODE_LENGTH = 7;

/** The same shape as players_member_code_shape_check in 00092. Uppercase only. */
const MEMBER_CODE_PATTERN = new RegExp(`^[${MEMBER_CODE_ALPHABET}]{${MEMBER_CODE_LENGTH}}$`);

/**
 * Whether this is a well-formed member code. Uppercase only and no tolerance
 * for the excluded characters: there is exactly one legal spelling of a code,
 * which is what lets the database get away with a plain UNIQUE index instead of
 * a functional one.
 */
export function isMemberCode(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return MEMBER_CODE_PATTERN.test(value);
}

/**
 * The member code for a player row, as a function of that row's id.
 *
 * MIRRORS derive_member_code() IN 00092 AND IS KEPT IN STEP WITH IT BY HAND,
 * the same arrangement deriveHandle() below has with the handle backfill and
 * name.ts has with 00023. Nothing in the app calls this to MINT a code — the
 * database does that, inside a transaction, behind a unique index. It exists so
 * the generator can be exercised: determinism, alphabet, length and collision
 * behaviour are all properties you want pinned by a test rather than discovered
 * on a hundred real members.
 *
 * DETERMINISTIC, AND THAT IS THE WHOLE REQUIREMENT. Not random(), not
 * gen_random_uuid(). 00092 is re-runnable by design and has already been
 * re-run; a random code would hand every member a different identity on each
 * run, which is the exact opposite of what a permanent identifier is for. So it
 * is a hash of the row's id — a UUID primary key, unique, never reused, never
 * rewritten for the life of the row. Same input, same output, forever.
 *
 * md5 rather than a faster hash for the same reason the SQL uses md5() rather
 * than hashtext(): hashtext()'s algorithm is a Postgres implementation detail
 * that has changed between major versions, so an upgrade would silently reissue
 * every code in the club. md5 is specified.
 *
 * `md5` is injected rather than imported. This module is bundled into a browser
 * — /settings is a client component — and reaching for node:crypto here would
 * put a Node builtin in that bundle to serve a function the browser never
 * calls. Injecting it is also what the file already does with `isTaken`, and
 * for the same reason: the caller owns the impure part.
 *
 * COLLISIONS ARE HANDLED, NOT HOPED ABOUT. See `isTaken`: a taken code is
 * REHASHED with an attempt counter (md5 of 'id:1', then 'id:2', …) rather than
 * incremented, because incrementing walks into whatever sits next to it in the
 * alphabet while a rehash lands somewhere unrelated. The counter starts at 0,
 * so the overwhelmingly common case hashes the id and nothing else, and the
 * whole ladder is still deterministic: the same row against the same set of
 * taken codes resolves the same way every time.
 */
export function deriveMemberCode(input: {
  playerId: string;
  md5: (text: string) => string;
  isTaken: (candidate: string) => boolean;
  maxAttempts?: number;
}): string {
  const maxAttempts = input.maxAttempts ?? 1000;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const source = attempt === 0 ? input.playerId : `${input.playerId}:${attempt}`;
    // Ten hex digits, not eight. The usual idiom folds 32 bits, and in SQL
    // `('x' || <8 hex digits>)::bit(32)::int` can come out NEGATIVE because the
    // top bit lands on int4's sign bit. Forty bits is comfortably positive in
    // both languages, is more than the ~34.3 the alphabet needs, and stays well
    // inside JavaScript's exact-integer range (2^40 < 2^53). The residual
    // modulo bias is about 0.6% and matters to nothing here.
    let n = parseInt(input.md5(source).slice(0, 10), 16) % 30 ** MEMBER_CODE_LENGTH;

    let code = '';
    for (let i = 0; i < MEMBER_CODE_LENGTH; i++) {
      // PREPENDED, not appended — the least-significant digit is computed
      // first. The SQL does `v_code := char || v_code`, and appending here
      // would produce a mirror-image code that passes every test about
      // alphabet, length and determinism while agreeing with the database
      // about nothing.
      code = MEMBER_CODE_ALPHABET[n % 30] + code;
      // Truncating division, matching BIGINT `/` in the SQL. Plain `/` in
      // JavaScript is the same silent mismatch as the line above.
      n = Math.floor(n / 30);
    }

    if (!input.isTaken(code)) return code;
  }
  throw new Error(`Could not derive a free member code for ${input.playerId}`);
}

/**
 * The handle 00092's backfill gives a member, as a function of the two names
 * already on their row.
 *
 * MIRRORS THE SQL IN 00092 AND IS KEPT IN STEP WITH IT BY HAND, the same
 * arrangement name.ts has with 00023. It exists so the ladder can be exercised
 * against real names without a database — which is not academic: the first
 * version of that backfill consulted display_name alone, and on staging 86 of
 * 99 members came out as `member_0014` because their nickname was empty. That
 * case is a one-line test here and was a full staging run there.
 *
 * The tiers, each checked in full — shape, reserved, taken — before it is
 * accepted:
 *
 *   1. the nickname, when they gave one;
 *   2. their full name, which is where most of a club lands. first_last rather
 *      than the first name alone: three Biancas means two of them would be
 *      pushed onto the tiebreak tier, and `bianca_2` says less to a reader than
 *      `bianca_chen` does;
 *   3. that base with `_2`, `_3`, … appended, first free wins;
 *   4. `member_k3f9tq2` — the member code, lowercased. Uncollidable, because
 *      the code is unique. Reached only by somebody with no usable text in
 *      EITHER name, which after tier 2 should be nobody.
 *
 * TIER 3 IS A PLAIN COUNTER AND NOT THE MEMBER CODE, which is a deliberate
 * decoupling and the most important thing on this function. It used to be the
 * member number, so the second Matthew was `matthew_6`; with a code that
 * spelling becomes `matthew_k3f9tq2`, which is not a name anybody would answer
 * to. But the real argument is not aesthetic. A handle is PUBLIC IDENTITY — a
 * member is `@kiera` on the leaderboard — and while the tiebreak was derived
 * from the identifier, every change to the identifier scheme dragged people's
 * handles with it. This file has already changed its identifier once and must
 * not be able to do that again. A counter is resolved against the handles
 * already taken and against nothing else, so the two schemes no longer move
 * together at all.
 *
 * Determinism survives the change: the counter is resolved against taken
 * handles and the backfill walks rows in a fixed (created_at, id) order, so the
 * same starting state always produces the same handles.
 *
 * `isTaken` is the caller's, because in the database the answer is a query and
 * here it is a set. Throws if the whole ladder is taken, rather than returning
 * null: a member without a handle is the outcome this ladder exists to prevent.
 */
export function deriveHandle(input: {
  displayName?: string | null;
  fullName?: string | null;
  memberCode: string;
  isTaken: (candidate: string) => boolean;
}): string {
  const nickBase = deriveHandleBase(input.displayName);
  const nameBase = deriveHandleBase(input.fullName);
  // The member's own text is preferred for the suffixed form too: somebody who
  // chose "Matthew" should become matthew_2 rather than matthew_cheng_2.
  const tiebreak = nickBase || nameBase;

  const candidates = [nickBase, nameBase];
  if (tiebreak) {
    // 2..99, matching the SQL's FOR v_n IN 2..99. A club that puts a hundred
    // people with the same name through this has a naming problem the fallback
    // below is a better answer to than a hundred-and-first suffix would be.
    for (let n = 2; n <= 99; n++) {
      const suffix = `_${n}`;
      candidates.push(
        tiebreak.slice(0, HANDLE_MAX_LENGTH - suffix.length).replace(/_+$/, '') + suffix,
      );
    }
  }
  candidates.push(`member_${input.memberCode.toLowerCase()}`);

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (handleError(candidate) !== null) continue;
    if (input.isTaken(candidate)) continue;
    return candidate;
  }
  throw new Error(`Could not derive a free handle for member ${input.memberCode}`);
}

/**
 * `K3F9TQ2`. Uppercased, and NOT padded — padding a code would invent
 * characters that are not in it, and the value is exactly seven characters
 * anyway. The `#` the sequential number carried is gone with it: `#` means
 * "number", and this is not one.
 *
 * Callers that need the word supply it, so the label lives with the layout that
 * has room for it (`MEMBER K3F9TQ2` on a profile, the bare code in a roster
 * cell) rather than being baked in here.
 *
 * Returns null for a member who has none — a pending signup has not been
 * assigned one yet, and every caller skips the line rather than drawing a bare
 * `MEMBER`.
 */
export function formatMemberCode(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.toUpperCase();
}

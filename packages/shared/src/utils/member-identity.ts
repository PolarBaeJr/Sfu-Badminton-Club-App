// The two public identifiers a member carries besides their name.
//
//   handle         a username the member picks and may change. Nullable, and
//                  NULL for every member who has not chosen one — which is all
//                  of them on the day this ships.
//   member_number  a sequential number the club assigns once and never reuses.
//                  Nobody types it; it is stamped when a person becomes a
//                  member. Deliberately NOT a university student number — no
//                  SFU data is stored anywhere near it.
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
 * `#0042`. Zero-padded to four because the club is nowhere near four digits and
 * a ragged column of #7 / #412 reads as a mistake; numbers past 9999 simply get
 * longer rather than being truncated.
 *
 * Returns null for a member who has none — a pending signup has not been
 * assigned one yet, and every caller skips the line rather than drawing a bare
 * `MEMBER #`.
 */
export function formatMemberNumber(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return `#${String(value).padStart(4, '0')}`;
}

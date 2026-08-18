// What "erased for good" actually has to erase.
//
// FIX-LIST #17. Two jobs anonymise a member row — purge-deleted-accounts (a
// member asked) and purge-inactive-accounts (the clock ran out) — and until now
// each carried its own copy of the field list. They agreed, but only because
// somebody kept them in step by hand, and the list itself was incomplete:
//
//   exec_photo_url  A PHOTOGRAPH OF THE PERSON'S FACE, rendered on /exec. When
//                   00130 split `bio` into `bio` + `exec_bio`, both lists were
//                   carefully updated for the new BIO column and neither looked
//                   at its photo sibling. `avatar_url` was nulled; this was not.
//                   The inactivity email promises "profile photo ... erased for
//                   good" in those words.
//   handle          `players.handle` is documented in 00092 as "the member's ONE
//                   chosen name", it is public, and it is what the roster search
//                   matches on. Leaving `@kiera` attached to a row now called
//                   Deleted Player means anyone who knew the handle can still
//                   find that person's whole record under the name they picked.
//                   The same email promises the name is erased.
//
// So the list lives here once and both jobs call it. Drift between the two is
// now impossible rather than merely unlikely, and
// apps/admin/src/lib/__tests__/deleted-identity.test.ts checks this list against
// every column `players` actually has, so a new identity column fails a test
// instead of quietly surviving a deletion.
//
// WHAT IS DELIBERATELY LEFT. Match results, ratings, session attendance and
// waiver acceptances all stay, attributed to the anonymised row — they are part
// of other members' records too, and the deletion email says so in as many
// words. `deletion_requested_at` also stays: it is the tombstone the purge
// query itself uses to find eligible rows, and it names no one.

/**
 * Every `players` column that carries who the person is, rather than what they
 * did. Exported for the test that pins it against the real table.
 */
export const IDENTITY_COLUMNS = [
  'first_name',
  'last_name',
  'display_name',
  'handle',
  'email',
  'phone',
  'avatar_url',
  'exec_photo_url',
  'bio',
  'exec_bio',
  'user_id',
] as const;

/**
 * The anonymising update, for a member whose retention window has elapsed.
 *
 * NEVER WRITES full_name. `players.full_name` is GENERATED ALWAYS (00023) from
 * first_name/last_name; writing it raises "column full_name can only be updated
 * to DEFAULT" and takes the whole update down with it — which, since this runs
 * last, is the worst available failure: the auth user is already gone and every
 * field this was meant to erase is still there. Two parts, never one string.
 */
export function anonymizedPlayerFields(playerId: string): Record<string, unknown> {
  return {
    first_name: 'Deleted',
    last_name: 'Player',
    display_name: null,
    // Nullable, and its uniqueness comes from a partial index on lower(handle)
    // (00092), so many anonymised rows can hold NULL at once. Readers already
    // expect NULL — 00092's own comment allows it for a member who never chose
    // one.
    handle: null,
    email: `deleted+${playerId}@deleted.invalid`,
    phone: null,
    avatar_url: null,
    exec_photo_url: null,
    bio: null,
    exec_bio: null,
    // Not identity, but part of the same act: the account can no longer be
    // signed in to, and it is off the active roster.
    active_flag: false,
    user_id: null,
  };
}

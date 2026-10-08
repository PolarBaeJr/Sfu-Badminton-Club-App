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
 * Tables whose rows are the member's own artifacts and nobody else's, keyed on
 * `player_id`, and which are DELETED rather than anonymised.
 *
 * Both purge jobs used to spell this list out inline, three tables each, and it
 * drifted the same way the field list below drifted: `player_discord_links` was
 * in neither.
 *
 * WHY THAT ONE MATTERED MOST. The purge anonymises the `players` row by UPDATE
 * and never deletes it, which is deliberate (see the header). So the link's
 * `ON DELETE CASCADE` never fires, and the row went on mapping a live Discord
 * snowflake to a member now called Deleted Player. A `players` row scrubbed of
 * every identifying field, still joined to the person's Discord account, is not
 * anonymised in any sense that matters: anyone holding the snowflake could read
 * straight through it.
 *
 * Deleting the link also does the right thing in Discord, which is the part
 * worth knowing before anybody "simplifies" this. 00165 puts a row trigger on
 * this table that captures the outgoing `discord_user_id` into
 * `discord_role_revocations` before it is lost, and the nightly sweep treats a
 * tombstone as "no player, strip everything". So the delete both breaks the
 * re-identification path AND takes the member's roles off the guild account the
 * club has stopped recognising. Leaving the link behind did neither: the sweep
 * iterates live links, so a purged member kept every role they had.
 *
 * The tombstone itself holds the snowflake until the bot confirms the strip,
 * then deletes it. That is transient by design and names no player.
 *
 * WHAT DOES NOT BELONG HERE. Anything a second member also appears in. Matches,
 * ratings, session attendance and waiver acceptances stay, attributed to the
 * anonymised row, for the reasons in the header. This list is only for rows that
 * would be meaningless to anyone but the person they belonged to.
 */
export const PERSONAL_ARTIFACT_TABLES = [
  'push_subscriptions',
  'passkey_credentials',
  'notifications',
  'player_discord_links',
  // A bearer credential, not a preference. `calendar_feed_tokens.token` is the
  // whole authentication for /api/calendar/[token]: calendar clients cannot log
  // in, so the unguessable string in the URL is it (00013).
  //
  // This is hygiene rather than a hole, and the distinction is worth recording
  // so nobody removes it as redundant. The feed route re-reads the player and
  // 404s on `!active_flag`, and the anonymising update below sets active_flag
  // false, so a purged member's subscription already stops resolving. What is
  // wrong is leaving a live secret attached to a row whose owner has been
  // erased: it means the erasure depends on one unrelated check in one route
  // continuing to exist. Delete the credential and it does not.
  'calendar_feed_tokens',
] as const;

/**
 * Tables where the LINK is cut and the row stays, by setting `player_id` to
 * NULL.
 *
 * One table, and it is here because its author already decided this and the
 * purge was quietly overriding them. Every other `player_id` in the schema is
 * `ON DELETE CASCADE`; `feedback_reports.player_id` is the single deliberate
 * `ON DELETE SET NULL`, and 00172 spells out the reason: "the report outlives
 * the account. A bug is still a bug after the person who found it leaves the
 * club." The column is nullable so that an unlinked member can file one at all.
 *
 * THE TRAP, and it is the same one `player_discord_links` fell into. That
 * intent is expressed as an FK action, and an FK action only fires on DELETE.
 * The purge anonymises by UPDATE and never deletes a players row, so SET NULL
 * has never once run. The report therefore keeps pointing at the purged member,
 * and `body` is up to 4000 characters of free text they typed, which routinely
 * contains the reporter's own name or address ("my email is not working"). The
 * declared design was right; nothing implemented it.
 *
 * So the purge does by hand what the constraint would have done: the report
 * survives, attributed to nobody.
 */
export const DELINKED_TABLES = ['feedback_reports'] as const;

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

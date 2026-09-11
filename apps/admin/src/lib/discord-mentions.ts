// Turning "@internal" into a mention Discord will actually ring, and back again.
//
// WHY THIS IS ITS OWN MODULE AND NOT PART OF THE ACTION. `actions/discord-message.ts`
// is a `'use server'` file, where every export must be an async function the
// client may call. A pure helper exported from there is a build error rather
// than a type error, so `npm run type-check` would say nothing about it. It does
// not belong in `announcement-shape.ts` either: that file is the page's shapes
// and its labels, imported by every client component on it, and this is the
// scanner.
//
// THE OLD REASON GIVEN HERE WAS THAT ROLE IDS HAVE NO BUSINESS IN A BROWSER
// BUNDLE, AND THAT IS NO LONGER TRUE. The console's preview draws the chip
// Discord draws, which needs an id to name, so the ids now travel to a browser
// that already held the capability to send a message containing one.
//
// SO THIS MODULE IS NOW IMPORTED BY A CLIENT COMPONENT (`discord-preview.tsx`)
// AND MUST STAY IMPORTABLE BY ONE. It imports nothing today and must never
// import the admin client, `next/headers`, or anything else server-only: doing
// so would not fail here, it would fail in the composer's bundle.

/** The role map as `discord_guild_roles` stores it. */
export interface GuildRole {
  role_name: string;
  role_id: string;
}

/**
 * One spelling for a role, whatever the writer typed.
 *
 * `session_staff` is the DB's name, `Session Staff` is what Discord shows, and
 * somebody typing it in a hurry writes `session-staff`. All three mean the same
 * role, so all three key the same way.
 */
function roleKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A merged role, and which table it came out of. */
export interface SourcedRole extends GuildRole {
  source: 'club' | 'server';
}

/**
 * The nine the club manages plus every other mentionable role in the server,
 * made into ONE list a picker can offer and `resolveRoleNames` can resolve.
 *
 * TWO TABLES, MERGED HERE AND NOWHERE ELSE. `discord_guild_roles` holds the nine
 * the app assigns, under a CHECK that must keep matching MANAGED_ROLES;
 * `discord_server_roles` (00229) is a catalogue the bot syncs out of Discord, with
 * no name whitelist at all. A database view unioning them was rejected: it would
 * be one relation name where the console needs to know which side a row came
 * from, and it would make the round-trip assertions in discord-message.test.ts
 * vacuous, since the fake client there answers an unknown table with `[]`.
 *
 * THREE PRECEDENCE RULES, AND EACH ONE IS A DECISION:
 *
 *  - SAME `role_id`: club wins. The catalogue contains all nine, because the bot
 *    posts every non-managed role it can see, so this is the MAIN path rather
 *    than an edge case. Backwards, the picker would show nine duplicates filed
 *    under the server heading.
 *  - SAME `roleKey`, DIFFERENT ids: club wins. A guild role called "Internal"
 *    beside the managed `internal` resolves to the managed one. Deliberate, and
 *    the reason the picker labels which is which.
 *  - TWO CATALOGUE ROWS on one key: BOTH DROPPED, and named in `ambiguous`. This
 *    is `planSetup`'s call in apps/bot/src/setup.ts, for its reason: picking one
 *    of two identically named roles at random decides who a message actually
 *    rings, and being wrong there is not a typo. The caller says so on screen,
 *    because a role plainly visible in Discord and missing from the picker with
 *    no explanation is worse than either.
 *
 * The order the offerable list comes back in is club rows first, in the order
 * they arrived, then catalogue rows in theirs. The caller sorts and groups.
 */
export function mergeGuildRoles(
  club: GuildRole[],
  server: GuildRole[],
): { roles: SourcedRole[]; ambiguous: string[] } {
  const clubRoles: SourcedRole[] = club.map((r) => ({ ...r, source: 'club' }));

  const claimedIds = new Set(clubRoles.map((r) => r.role_id));
  const claimedKeys = new Set(clubRoles.map((r) => roleKey(r.role_name)));

  // Keyed before anything is dropped, so a name held by three rows is reported
  // once rather than twice.
  const byKey = new Map<string, GuildRole[]>();
  for (const role of server) {
    if (claimedIds.has(role.role_id)) continue;
    const key = roleKey(role.role_name);
    if (!key || claimedKeys.has(key)) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(role);
    else byKey.set(key, [role]);
  }

  const serverRoles: SourcedRole[] = [];
  const ambiguous: string[] = [];
  for (const bucket of byKey.values()) {
    // Two rows sharing an id cannot happen: (guild_id, role_id) is the
    // catalogue's primary key. Two rows sharing a NAME can, and Discord allows it.
    if (bucket.length > 1) {
      ambiguous.push(bucket[0]!.role_name);
      continue;
    }
    const only = bucket[0]!;
    serverRoles.push({ ...only, source: 'server' });
  }

  return { roles: [...clubRoles, ...serverRoles], ambiguous };
}

/**
 * ONE SCAN, ORDERED SO THE PROTECTED FORMS WIN.
 *
 * A mention that is already a mention matches the first branch and is re-emitted
 * whole, which gives the never-rewrite-an-existing-mention property without a
 * lookbehind and makes this function idempotent: run it on its own output and
 * nothing moves. `@everyone` and `@here` match before the name branch can claim
 * them, because Discord resolves those itself and rewriting them would break
 * them.
 *
 * The name branch takes up to TWO words so `@session staff` can be found. The
 * backoff below is what stops that swallowing an ordinary sentence.
 */
const MENTION_SCAN = /<@[&!]?\d+>|@everyone|@here|@([A-Za-z0-9_-]+(?:[ ][A-Za-z0-9_-]+)?)/g;

/**
 * What may sit immediately before an `@` that starts a mention.
 *
 * Whitespace is the ordinary case; the punctuation is markdown, so `**@internal**`
 * and `"@internal"` still resolve. Everything else means the `@` is inside a
 * word, which is how `wkc10@sfu.ca` survives a Code of Conduct unharmed.
 */
const MENTION_OPENERS = new Set(['(', '[', '{', '"', "'", '*', '~', '>']);

function mayStartMention(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1]!;
  return /\s/.test(before) || MENTION_OPENERS.has(before);
}

/**
 * Rewrite role names in `text` as real Discord mentions.
 *
 * AN UNKNOWN NAME IS LEFT AS LITERAL TEXT AND IS NEVER AN ERROR. The message
 * this feature exists for is a Code of Conduct, which will contain email
 * addresses, "meet @ the gym" and Discord usernames. Refusing prose that is
 * perfectly fine would turn a composer that works today into one that argues,
 * and a literal `@varsity` is exactly what gets posted today anyway: the worst
 * case here is the status quo.
 *
 * Returns the canonical DB spellings of the roles actually substituted, deduped
 * and sorted, so the audit entry can say which role was aimed at without
 * storing a wall of snowflakes.
 */
export function resolveRoleMentions(
  text: string,
  roles: GuildRole[],
): { text: string; matched: string[] } {
  const byKey = new Map<string, GuildRole>();
  for (const role of roles) byKey.set(roleKey(role.role_name), role);

  const matched = new Set<string>();
  let out = '';
  let last = 0;

  // The regex is module scope and global, so its cursor is shared between calls.
  MENTION_SCAN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MENTION_SCAN.exec(text)) !== null) {
    const whole = match[0];
    const candidate = match[1];
    out += text.slice(last, match.index);
    last = match.index + whole.length;

    // An existing mention, an @everyone, an @here, or an `@` in the middle of a
    // word. All four are re-emitted byte for byte.
    if (candidate === undefined || !mayStartMention(text, match.index)) {
      out += whole;
      continue;
    }

    const full = byKey.get(roleKey(candidate));
    if (full) {
      out += `<@&${full.role_id}>`;
      matched.add(full.role_name);
      continue;
    }

    // THE TWO-WORD BACKOFF. "@session courts are closed" captured "session
    // courts", which is not a role. Without retrying the first word alone the
    // scan would consume "courts" and either lose it or attach it to a mention
    // that never included it. The tail is re-emitted from the original text, so
    // whatever separated the two words comes back exactly as typed.
    const words = candidate.split(' ');
    if (words.length === 2) {
      const first = byKey.get(roleKey(words[0]!));
      if (first) {
        out += `<@&${first.role_id}>` + whole.slice(1 + words[0]!.length);
        matched.add(first.role_name);
        continue;
      }
    }

    out += whole;
  }

  out += text.slice(last);

  return { text: out, matched: [...matched].sort() };
}

/** Every mention this module can have written, and nothing else. */
const MENTION_IDS = /<@&(\d+)>/g;

/**
 * The way back: `<@&123...>` to `@internal`, for a composer that is about to
 * show somebody their own words.
 *
 * WHY THIS IS WRITTEN IN TERMS OF `resolveRoleMentions` RATHER THAN BESIDE IT.
 * The forward direction is not a regex substitution: it normalises the key,
 * takes up to two words with a backoff, and protects `@everyone`, an address in
 * a Code of Conduct and a mention that is already one. A second rule guessing at
 * the inverse of all that would be a second answer to the same question, and the
 * first thing it would get wrong is a role whose name cannot survive the trip.
 *
 * SO EVERY REPLACEMENT IS PROVEN, TWICE:
 *
 *  - Per mention: `@` plus the name must resolve back to exactly this id, and
 *    the character before the `<` must be one that could have opened a mention.
 *    That rejects a three-word name, an emoji, a `!`, anything outside
 *    [A-Za-z0-9_-] and a name colliding with another role under `roleKey`. Such
 *    a mention keeps its raw form, which is what the screen showed before.
 *  - Whole string: resolving the result must reproduce the input byte for byte.
 *    If it does not, the ORIGINAL comes back untouched, ids and all. Reverting
 *    all of them for one bad neighbour is deliberate and is not to be
 *    "improved" into partial application: a body that saves back differently
 *    from how it was posted is a worse failure than a snowflake on screen, and
 *    the worst case here is the status quo.
 */
export function unresolveRoleMentions(text: string, roles: GuildRole[]): string {
  const byId = new Map<string, GuildRole>();
  for (const role of roles) byId.set(role.role_id, role);

  let out = '';
  let last = 0;

  // Module scope and global, so the cursor is shared between calls.
  MENTION_IDS.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MENTION_IDS.exec(text)) !== null) {
    const whole = match[0];
    const role = byId.get(match[1]!);
    out += text.slice(last, match.index);
    last = match.index + whole.length;

    if (
      role &&
      mayStartMention(text, match.index) &&
      resolveRoleMentions(`@${role.role_name}`, roles).text === whole
    ) {
      out += `@${role.role_name}`;
      continue;
    }

    // An id the guild map cannot name, a name that will not round-trip, or a
    // mention glued to a word character. All three stay as they arrived.
    out += whole;
  }

  out += text.slice(last);

  return resolveRoleMentions(out, roles).text === text ? out : text;
}

/**
 * Turn role names somebody PICKED into ids, rather than names they typed.
 *
 * The ping line above an embed is built from a picker, not from prose, so none
 * of the scanning above applies: there is no surrounding sentence to protect
 * and no two-word backoff to make. What it does share is the normalisation, and
 * that is the whole reason this lives here. `roleKey` is what makes
 * `Session Staff`, `session_staff` and `session-staff` one role, and a second
 * copy of that rule in the action would be a second answer to the same
 * question.
 *
 * AN UNKNOWN NAME COMES BACK NAMED, never dropped. The caller refuses the whole
 * message on one: a silently dropped ping role is a message that looks sent and
 * rings nobody, which is the exact failure the ping line exists to remove.
 * Duplicates and blanks are dropped, because those are the same request twice.
 */
export function resolveRoleNames(
  names: string[],
  roles: GuildRole[],
): { ids: string[]; matched: string[]; unknown: string[] } {
  const byKey = new Map<string, GuildRole>();
  for (const role of roles) byKey.set(roleKey(role.role_name), role);

  const ids: string[] = [];
  const matched: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    const key = roleKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const role = byKey.get(key);
    if (!role) {
      unknown.push(name);
      continue;
    }
    ids.push(role.role_id);
    matched.push(role.role_name);
  }

  return { ids, matched, unknown };
}

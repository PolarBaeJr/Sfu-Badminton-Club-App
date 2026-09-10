// Turning "@internal" into a mention Discord will actually ring.
//
// WHY THIS IS ITS OWN MODULE AND NOT PART OF THE ACTION. `actions/discord-message.ts`
// is a `'use server'` file, where every export must be an async function the
// client may call. A pure helper exported from there is a build error rather
// than a type error, so `npm run type-check` would say nothing about it. It
// cannot live in `announcement-shape.ts` either: the client imports that file,
// and role ids have no business in a browser bundle.

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

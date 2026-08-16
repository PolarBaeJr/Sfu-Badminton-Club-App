// Client/server mirror of the name split/join in 00023_split_player_name.sql:
// the backfill's regex split, and the players.full_name generation
// expression. Deliberate duplication, same rule as the ELO engine
// (docs/DEVELOPMENT.md:84) — change both together or names drift between
// what a form shows and what the database stores.

export interface NameParts {
  first_name: string;
  last_name: string | null;
}

// Collapse internal whitespace runs to one space, trim, split on the FIRST
// space. A mononym ("Cher") yields last_name null.
export function splitFullName(full: string): NameParts {
  const normalized = full.replace(/\s+/g, ' ').trim();
  const space = normalized.indexOf(' ');
  if (space === -1) return { first_name: normalized, last_name: null };
  return {
    first_name: normalized.slice(0, space),
    last_name: normalized.slice(space + 1) || null,
  };
}

// Mirrors the generated column: btrim(first || coalesce(' ' || nullif(btrim(last), ''), '')).
export function joinName(first: string, last?: string | null): string {
  const trimmedLast = (last ?? '').trim();
  return (trimmedLast ? `${first} ${trimmedLast}` : first).trim();
}

/**
 * Split a doubles entry's display label back into one line per partner.
 *
 * WHY THIS EXISTS: a draw card's name field is about 130px wide (the player
 * app's chart column is 168px, the console's 196px), and a doubles label is two
 * whole names joined — "Jonathan Smithson & Katarzyna Kowalski" is 38
 * characters, roughly 240px at the 13px the cards are set in. It truncated to
 * "Jonathan Smit…" and told the reader nothing about who the pair actually is.
 * Stacked, each partner gets the FULL width to itself and both names print.
 *
 * A PRINTED DRAW SHEET HAS ALWAYS DONE THIS. Two names, one over the other, in
 * the slot the pair occupies. It is the layout the format was designed for.
 *
 * The two apps join the two names differently — the player app with " & ", the
 * console with " / " when a pair has no name of its own — so both separators
 * are recognised. Anything else comes back as a single line, which is what
 * keeps a singles player's name and a pair's CUSTOM name (`pair_name`, free
 * text) whole: neither is two names and neither should be cut in half.
 *
 * Nothing is dropped, so the caller's `title`/`aria-label` can go on using the
 * original string.
 */
export function splitPairLabel(label: string): string[] {
  const parts = label.split(/ [&/] /);
  // A three-way split cannot be a badminton pair, so it is more likely a name
  // that happens to contain the separator than a partnership — leave it whole.
  if (parts.length !== 2) return [label];
  const trimmed = parts.map((p) => p.trim());
  return trimmed.every((p) => p.length > 0) ? trimmed : [label];
}

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

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// TWO PUBLIC PAGES MUST NOT CALL THE SAME PERSON TWO DIFFERENT THINGS.
//
// /leaderboard and /exec are both reachable signed out, and each takes its
// names from its own SECURITY DEFINER function. 00092 retired the free-text
// nickname and moved get_leaderboard()'s `name` from COALESCE(display_name,
// full_name) to full_name — a change it called out as visible on a public page
// — and did not touch get_executives(), which went on returning the nickname.
// So an officer was "Kiera Watanabe" on the ladder and "kiera" on the exec
// page for as long as that lasted. 00096 is the other half.
//
// The failure was not that either function was wrong on its own. It was that
// nothing said the two had to agree, so a migration could move one. This is
// that statement, and it is deliberately made against the LAST definition of
// each function in the whole directory rather than against a named file: a
// migration is applied by piping the file into psql, so the last CREATE wins,
// and pinning a file number would go stale the first time either is redefined.
//
// Reading the SQL as text is crude, and it is the same crudeness
// capability-storage.test.ts settles for and for the same reason: anything
// cleverer would be a second place the rule is written down.

const MIGRATIONS = join(__dirname, '../../../../../supabase/migrations');

/**
 * The body of the LAST definition of `fn` in the migrations directory.
 *
 * From the CREATE to the dollar-quote that closes it. Both quoting styles the
 * repo uses are accepted — hand-written migrations write `$$`, bodies pasted
 * back from pg_get_functiondef() write `$function$`.
 */
function lastDefinitionOf(fn: string): { file: string; body: string } {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  // Optional `public.`, and OR REPLACE optional, because the directory contains
  // both spellings of the same act.
  const create = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${fn}\\s*\\(`, 'g');

  for (const file of [...files].reverse()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    const starts = [...sql.matchAll(create)].map((m) => m.index!);
    if (starts.length === 0) continue;
    const from = starts[starts.length - 1]!;
    const tag = sql.indexOf('$function$', from) !== -1
      && (sql.indexOf('$function$', from) < (sql.indexOf('$$', from) === -1 ? Infinity : sql.indexOf('$$', from)))
      ? '$function$'
      : '$$';
    const open = sql.indexOf(tag, from);
    const close = sql.indexOf(tag, open + tag.length);
    if (open === -1 || close === -1) throw new Error(`unterminated body for ${fn} in ${file}`);
    return { file, body: sql.slice(from, close + tag.length) };
  }
  throw new Error(`no definition of ${fn} in ${MIGRATIONS}`);
}

/** `name` selected from the retired nickname column, in any spelling. */
const NICKNAME_AS_NAME = /COALESCE\s*\([^)]*display_name[^)]*\)\s+AS\s+name\b/i;

describe('the public pages agree about a member’s name', () => {
  // ORDER BY is deliberately not covered. get_executives() still sorts on
  // COALESCE(display_name, full_name) as its last tiebreaker — 00096 says why
  // it was left alone — and a sort key is not a name anybody reads.
  for (const fn of ['get_leaderboard', 'get_executives']) {
    it(`${fn}() returns full_name as the member's name`, () => {
      const { file, body } = lastDefinitionOf(fn);
      expect(body, `${fn} defined in ${file}`).toMatch(/\bfull_name AS name\b/);
      expect(body, `${fn} defined in ${file} still returns the retired nickname`)
        .not.toMatch(NICKNAME_AS_NAME);
    });
  }

  it('finds the newest definition, not the first one written', () => {
    // 00042 defined get_executives() with the nickname and 00096 redefined it.
    // If this helper ever started returning the earlier file the two assertions
    // above would pass or fail for the wrong reason, so it is pinned too.
    expect(lastDefinitionOf('get_executives').file).toMatch(/^00096_/);
    expect(lastDefinitionOf('get_leaderboard').file).toMatch(/^00092_/);
  });
});

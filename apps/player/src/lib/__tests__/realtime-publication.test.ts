import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// A SUBSCRIPTION TO AN UNPUBLISHED TABLE SUCCEEDS AND THEN NEVER FIRES.
//
// That is the whole hazard, and it has already happened once here: 00036 was
// written because `supabase_realtime` contained ZERO tables while two screens
// subscribed to it, so live standings and the announcements badge "worked" and
// silently did not. Nothing errors — .subscribe() resolves, the callback just
// never runs — so the only way to find out is to notice a stale number.
//
// Reading both sides as text is crude and deliberate. The alternative is
// trusting a comment in 00036 that lists the tables, which is what went stale.
//
// Note what this does NOT check: whether the migration has been APPLIED. It
// cannot — nothing in this repository tracks that, migrations are piped into
// psql by hand. It checks that somebody wrote the statement down, which is the
// part a code review can catch.

const SRC = join(__dirname, '../..');
const MIGRATIONS = join(__dirname, '../../../../../supabase/migrations');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    // Tests are not the app, and this file itself contains the literal the
    // scan below looks for — left in, the guard would eventually be checking
    // its own fixtures.
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Every table named by a postgres_changes subscription in the player app. */
function subscribedTables(): { table: string; file: string }[] {
  const found: { table: string; file: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    // The config object follows the 'postgres_changes' argument, so the table
    // is the first `table: '…'` after each occurrence of it.
    for (const match of text.matchAll(/'postgres_changes'/g)) {
      const window = text.slice(match.index!, match.index! + 400);
      const table = window.match(/table:\s*'([a-z_]+)'/);
      if (table) found.push({ table: table[1]!, file: file.slice(SRC.length + 1) });
    }
  }
  return found;
}

/** Every table any migration adds to the supabase_realtime publication. */
function publishedTables(): Set<string> {
  const published = new Set<string>();
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, name), 'utf8');
    for (const match of sql.matchAll(
      /ALTER\s+PUBLICATION\s+supabase_realtime\s+ADD\s+TABLE\s+([^;]+);/gi,
    )) {
      for (const raw of match[1]!.split(',')) {
        published.add(raw.trim().replace(/^public\./, ''));
      }
    }
  }
  return published;
}

describe('every table the player app subscribes to is published to Realtime', () => {
  const subscribed = subscribedTables();

  it('finds the subscriptions at all', () => {
    // If the extraction above silently stopped matching, every assertion below
    // would pass over an empty list.
    expect(subscribed.length).toBeGreaterThanOrEqual(3);
    expect(new Set(subscribed.map((s) => s.table))).toContain('announcements');
  });

  it('publishes each of them', () => {
    const published = publishedTables();
    const missing = subscribed.filter((s) => !published.has(s.table));
    expect(
      missing.map((m) => `${m.table} (subscribed in ${m.file})`),
      'a subscription to an unpublished table succeeds and then never fires',
    ).toEqual([]);
  });

  it('publishes announcement_reads, which is what lets the badge clear itself', () => {
    // The badge's own case, named rather than left to the loop: the nav
    // subscribes to the viewer's read rows, and that listener is inert until
    // 00096 is applied. If somebody deletes the ALTER without deleting the
    // listener, this is the test that says so.
    expect(publishedTables()).toContain('announcement_reads');
  });
});

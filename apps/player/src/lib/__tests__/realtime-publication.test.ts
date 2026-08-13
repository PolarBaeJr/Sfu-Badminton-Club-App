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
    //
    // A FLOOR, RAISED WHENEVER SUBSCRIPTIONS ARE ADDED, and worth raising: it
    // was 3 while the app had 3, and it is the only thing standing between a
    // silently broken extraction and a suite that passes over nothing. The
    // count today is 13 — ratings on /leaderboard, announcements and
    // announcement_reads in the nav, ratings again in live-rating.tsx, the
    // four tournament tables in live-tournament.tsx, and five in
    // live-matches.tsx: match_participants, challenge_participants,
    // challenges, and `matches` twice over (the per-challenge filter and
    // /feed's unfiltered club river).
    //
    // WHAT THIS FLOOR CANNOT DO, written down because it is easy to over-trust.
    // It is a `>=`, so it catches a subscription DELETED and not one that has
    // gone INVISIBLE to the scan: prose wedged between a postgres_changes
    // literal and its config object hides that subscription from this file
    // while every other occurrence keeps the count up. That is exactly the
    // mistake 5d100de made, it is why every live-* component carries a comment
    // saying not to do it, and it is why the assertions below name their
    // tables instead of trusting the loop.
    expect(subscribed.length).toBeGreaterThanOrEqual(13);
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

  it('publishes the four tables a club match moves through', () => {
    // The member's own case, named rather than left to the loop above. Two
    // people play, ONE submits the score, and the other is on a different
    // phone waiting to be asked to confirm it — so every one of these
    // listeners exists for somebody who wrote nothing and whom
    // revalidatePath therefore never reaches. All four are inert until 00114
    // is applied. If somebody deletes an ALTER without deleting the listener,
    // this is the test that says so.
    //
    // `matches` is the one to look at hardest: /feed subscribes to it
    // UNFILTERED, and /feed is the only page in the app no write path
    // revalidates at all, so if that ALTER goes the club river is not merely
    // slow, it is permanently frozen for everyone.
    const published = publishedTables();
    for (const table of ['matches', 'match_participants', 'challenges', 'challenge_participants']) {
      expect(published, `${table} is subscribed but not published`).toContain(table);
    }
  });

  it('never publishes players, whatever else it publishes', () => {
    // NOT A SUBSCRIPTION CHECK — the inverse, and the only assertion in this
    // file that would still matter if every listener were deleted tomorrow.
    //
    // 00032 did not change the players_select RLS policy. It REVOKED
    // table-level SELECT and re-granted a column whitelist, and POSTGRES
    // LOGICAL REPLICATION DOES NOT HONOUR COLUMN-LEVEL GRANTS. So adding
    // `players` to this publication would stream `email` and `phone` to every
    // subscriber whose row filter passes — the exact columns 00032 exists to
    // withhold — through a channel that never consults the grant. No
    // subscription-side filtering could contain it: any member can open their
    // own socket and ask for anything.
    //
    // Every live-* component in this app is refresh-only so that names stay
    // server-rendered and this line can stay true. It is cheap to assert and
    // the failure it guards against is silent, permanent and unrecallable.
    expect(publishedTables()).not.toContain('players');
  });

  it('publishes the four tables a tournament draw moves through', () => {
    // The bracket's own case, named rather than left to the loop: an entrant
    // watching a draw from courtside is the reader least able to tell a live
    // screen from a dead one, because a round that has not been played and a
    // round whose result never arrived look identical. All four are inert
    // until 00113 is applied.
    const published = publishedTables();
    for (const table of [
      'tournament_events',
      'tournament_matches',
      'tournament_participants',
      'tournament_pairs',
    ]) {
      expect(published, `${table} is subscribed but not published`).toContain(table);
    }
  });

  it('still names ratings, which is what makes a member their own live rating', () => {
    // /my-stats and /feed watch the viewer's own row. Unlike every other entry
    // here this one needed no migration — 00036 published `ratings` for the
    // leaderboard years earlier — so the usual "somebody forgot the ALTER"
    // failure cannot happen to it. What CAN happen is somebody deciding the
    // leaderboard no longer needs it and removing the table from 00036, which
    // would take these two screens down with it silently.
    expect(publishedTables()).toContain('ratings');
    expect(subscribed.map((s) => s.file)).toContain('components/live-rating.tsx');
  });
});

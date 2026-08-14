import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// A SUBSCRIPTION TO AN UNPUBLISHED TABLE SUCCEEDS AND THEN NEVER FIRES.
//
// That is the whole hazard, and it has already happened once in this
// repository: 00036 was written because `supabase_realtime` contained ZERO
// tables while two player screens subscribed to it, so live standings and the
// announcements badge "worked" and silently did not. Nothing errors —
// .subscribe() resolves, the callback just never runs — so the only way to
// find out is to notice a stale number.
//
// THE DELIBERATE SIBLING of apps/player/src/lib/__tests__/realtime-publication
// .test.ts, which does the same scan over the player tree. That one existed
// first and covered only apps/player, so the moment the console grew its own
// subscription (the sessions door surfaces, 00112) the guard stopped covering
// the code with the most to lose from the failure: an exec staring at a door
// list that has quietly stopped updating has no way to tell it apart from a
// quiet night.
//
// DO NOT "DEDUPE" THE TWO INTO ONE CROSS-APP SCAN. The duplication is the
// point: each app's own suite guards its own tree, so neither app's coverage
// depends on somebody remembering to run the other's, and a future split or
// move of either app cannot silently take the other's guard with it. This is
// the same shape as tournament-notification-routes.test.ts — a call-site
// convention defended by reading the source, because a behavioural test only
// covers the call sites somebody remembered to write a case for, which is
// exactly what failed here.
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

/** Every table named by a postgres_changes subscription in the admin app. */
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

describe('every table the admin app subscribes to is published to Realtime', () => {
  const subscribed = subscribedTables();

  it('finds the subscriptions at all', () => {
    // If the extraction above silently stopped matching, every assertion below
    // would pass over an empty list — the guard failing the same way the thing
    // it guards fails.
    //
    // A FLOOR, RAISED WHENEVER SUBSCRIPTIONS ARE ADDED. It was 1 while the
    // console had one, then 5 with the door and the four tournament tables in
    // live-tournament.tsx; 7 now that the matches ledger watches `matches`.
    //
    // WHAT THIS FLOOR CANNOT DO. It is a `>=`, so it catches a subscription
    // DELETED and not one that has gone INVISIBLE to the scan — prose wedged
    // between a postgres_changes literal and its config object hides that
    // subscription from this file while other occurrences keep the count up.
    // That is why the assertions below name their tables rather than trusting
    // the loop, and why every live-* component carries a comment about it.
    expect(subscribed.length).toBeGreaterThanOrEqual(7);
    expect(new Set(subscribed.map((s) => s.table))).toContain('session_attendance');
  });

  it('publishes each of them', () => {
    const published = publishedTables();
    const missing = subscribed.filter((s) => !published.has(s.table));
    expect(
      missing.map((m) => `${m.table} (subscribed in ${m.file})`),
      'a subscription to an unpublished table succeeds and then never fires',
    ).toEqual([]);
  });

  it('publishes session_attendance, which is what makes the door surfaces live', () => {
    // The door's own case, named rather than left to the loop above: the
    // sessions page and its attendance dialog both watch this table, and both
    // listeners are inert until 00112 is applied. If somebody deletes the
    // ALTER without deleting the listeners, this is the test that says so.
    expect(publishedTables()).toContain('session_attendance');
  });

  it('publishes the four tables a tournament draw moves through', () => {
    // The console's own version of the door's case. Two execs run a tournament
    // from opposite ends of the gym and neither sees the other's writes without
    // a reload — which is not merely stale, it is how a round gets generated
    // against occupants that have already changed. All four are inert until
    // 00113 is applied. If somebody deletes an ALTER without deleting the
    // listener, this is the test that says so.
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

  it('publishes matches, which is what makes the club ledger live', () => {
    // The console's club-play case, named rather than left to the loop. Unlike
    // the door and the tournament screens, most of the writes this listener
    // exists for are not made by an exec at all: members submit and confirm
    // results from their phones all evening and every one of them lands in the
    // ledger /matches draws. revalidatePath has never covered any of them.
    //
    // Inert until 00114 is applied. If somebody deletes the ALTER without
    // deleting the listener, this is the test that says so — and the failure
    // is invisible from the screen, because an exec watching a list that has
    // quietly stopped updating cannot tell it from a quiet night.
    expect(publishedTables()).toContain('matches');
  });

  it('never publishes players, whatever else it publishes', () => {
    // NOT A SUBSCRIPTION CHECK — the inverse, and the only assertion in this
    // file that would still matter if every listener were deleted tomorrow.
    // Deliberately duplicated from the player app's guard, on the same
    // reasoning the header gives for duplicating the whole file: each app's
    // suite defends its own tree, and this migration set is edited from both.
    //
    // 00032 did not change the players_select RLS policy. It REVOKED
    // table-level SELECT and re-granted a column whitelist, and POSTGRES
    // LOGICAL REPLICATION DOES NOT HONOUR COLUMN-LEVEL GRANTS. Publishing
    // `players` would stream `email` and `phone` to every subscriber whose row
    // filter passes, through a channel that never consults the grant, and no
    // subscription-side filtering could contain it — any member can open their
    // own socket. Cheap to assert; silent, permanent and unrecallable to get
    // wrong.
    expect(publishedTables()).not.toContain('players');
  });

  it('never publishes match_admin_notes, whatever else it publishes', () => {
    // THE SECOND INVERSE GUARD, and it exists because `matches` IS published.
    //
    // 00114 put `matches` in this publication and wrote down, honestly, that
    // `admin_note` therefore streams the exec's own words about a void to every
    // signed-in subscriber — not a new exposure, because matches_select is
    // USING (TRUE), but a real one. 00117 moves that text to
    // `match_admin_notes`, a table with no grant for `authenticated` and RLS on
    // with no policy.
    //
    // PUBLISHING IT WOULD UNDO ALL OF THAT IN ONE LINE, and silently. Logical
    // replication does not honour column grants — the reason `players` may
    // never be published — and it does not consult a table's grants either. The
    // console does not subscribe to this table and has no reason to: every
    // write to it happens in the same action as a write to `matches`, which is
    // already published and already wakes this page up.
    //
    // The temptation is concrete rather than theoretical: somebody adding a
    // note to the live ledger will notice the strip does not appear until a
    // refresh, and the one-line fix is exactly the line this test forbids.
    expect(publishedTables()).not.toContain('match_admin_notes');
  });
});

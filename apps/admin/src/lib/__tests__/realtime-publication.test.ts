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

/**
 * Every table any migration gives a WIDENING replica identity, with the setting
 * it was given.
 *
 * A SECOND AXIS THE SCAN ABOVE CANNOT SEE. `publishedTables()` answers "is this
 * table's traffic on the wire at all". Replica identity answers "how much of a
 * row goes with it" — specifically, how much of the OLD row an UPDATE or a
 * DELETE carries. They are independent, and until 00120 nothing in this
 * repository looked at the second one, so the single line that would put every
 * deleted row's full contents on the wire was invisible to the guard that
 * exists to notice exactly that class of change.
 *
 * WHY THIS IS A TEXT SCAN, like the one above and with the same limitation: it
 * reads the migration directory as source, so an ALTER built with EXECUTE
 * format(...) is invisible to it. 00120 writes both of its statements out
 * longhand inside their DO blocks for precisely this reason, and any future one
 * must too.
 */
function widenedReplicaIdentity(): Map<string, string> {
  const found = new Map<string, string>();
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, name), 'utf8');
    for (const match of sql.matchAll(
      /ALTER\s+TABLE\s+(?:ONLY\s+)?([\w.]+)\s+REPLICA\s+IDENTITY\s+(FULL|DEFAULT|NOTHING|USING\s+INDEX\s+[\w.]+)/gi,
    )) {
      const table = match[1]!.replace(/^public\./, '');
      const setting = match[2]!.toUpperCase().replace(/\s+/g, ' ');
      // DEFAULT and NOTHING both NARROW the old tuple rather than widening it,
      // so neither can put a column on the wire. A later migration setting one
      // of those therefore retracts an earlier FULL — hence the sorted read and
      // the delete, so this reports the setting a table ENDS UP with.
      if (setting === 'DEFAULT' || setting === 'NOTHING') found.delete(table);
      else found.set(table, setting);
    }
  }
  return found;
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

  it('never publishes any of 00118\'s private note tables, whatever else it publishes', () => {
    // THE SAME GUARD, WIDENED — and here the temptation is sharper than it was
    // for match_admin_notes, because THREE of these four parents are published.
    //
    // 00113 put tournament_events, tournament_matches, tournament_participants
    // and tournament_pairs in this publication for the live bracket. That is
    // exactly what made their `notes` columns stream an exec's void reason and
    // disqualification reason to every subscriber, and it is why 00118 moved
    // the text out rather than trying to withhold a column — logical
    // replication does not honour column-level grants, the same reason `players`
    // may never be published.
    //
    // THE PARENTS STAY PUBLISHED, deliberately: the live bracket is built on
    // them and the loop above asserts they are there. So this is the assertion
    // that keeps 00118 meaningful. Publishing any of these four would undo it
    // in one line and silently, and nothing subscribes to them or should: every
    // write to one happens in the same action as a write to its parent, which
    // is already published and already wakes these screens up.
    //
    // walkover_admin_notes is named alongside the other three even though
    // `walkovers` is not published either. It is listed because the reason it
    // must never be published is not "its parent isn't" — it is the same reason
    // as the rest, and a future migration publishing `walkovers` for a walkover
    // queue badge must not silently take the verdicts with it.
    const published = publishedTables();
    for (const table of [
      'tournament_participant_notes',
      'tournament_pair_notes',
      'tournament_match_notes',
      'walkover_admin_notes',
    ]) {
      expect(published, `${table} must never be published`).not.toContain(table);
    }
  });
});

// ============================================================
// REPLICA IDENTITY — HOW MUCH OF A ROW TRAVELS
// ============================================================
// THE OTHER HALF OF THE SAME QUESTION, and the half that had no guard at all
// until 00120.
//
// Publication decides WHETHER a table's changes are on the wire. Replica
// identity decides HOW MUCH OF THE OLD ROW goes with an UPDATE or a DELETE. The
// default is the primary key alone; FULL is every column, and a table can be
// switched to it in one line that no existing assertion in this file would
// notice.
//
// WHY THAT LINE IS TEMPTING, concretely rather than in the abstract: under the
// default a DELETE's tuple is the primary key alone, so a subscription filtered
// on any other column is never routed the event and a removed row stays on
// screen. 00112, 00113 and 00114 each wrote that limitation down and each
// declined to fix it. FULL makes the filter evaluable and closes the gap in one
// statement, on any table, and the person reaching for it is fixing something
// real — a door list that still shows somebody an exec just un-marked. It is
// the right answer on a table of ids and timestamps and the wrong one on a
// table carrying an exec's private note, and nothing about the statement itself
// says which.
//
// SO THE LIST IS PINNED BY NAME. Adding a table here is a deliberate act that
// has to survive review, which is the whole of what a text-scanning guard can
// offer and is exactly what it offered for the publication.
//
// DELIBERATELY DUPLICATED into the player app's copy of this file, on the same
// reasoning the header gives for duplicating the whole file: each app's suite
// defends its own tree, the migration set is edited from both, and neither
// app's coverage may depend on somebody remembering to run the other's.
describe('replica identity is widened only where a row is all ids and timestamps', () => {
  // THE ONLY TWO, both set by 00120, and the case for each is the same
  // sentence: every column is an id, a timestamp, or a value chosen from a
  // fixed menu, and the SELECT policy is already USING (TRUE), so no reader
  // gains anything they could not already SELECT.
  //
  //   session_attendance — id, session_id, player_id, checked_in_at, status,
  //     marked_by, marked_at. Never had a text column (00001:266 + 00008:14).
  //     This is the console's own case: clearAttendanceMark DELETEs the row,
  //     and until 00120 that removal reached nobody but the exec who made it.
  //   tournament_events  — format, seeding and status; its TEXT columns are
  //     CHECK-constrained enumerations and method names, never prose.
  const ALLOWED = ['session_attendance', 'tournament_events'];

  it('widens exactly the tables 00120 names and no others', () => {
    const widened = widenedReplicaIdentity();
    const unexpected = [...widened].filter(([table]) => !ALLOWED.includes(table));
    expect(
      unexpected.map(([table, setting]) => `${table} (${setting})`),
      'a widened replica identity puts every column of the OLD row on the wire',
    ).toEqual([]);
  });

  it('finds 00120 at all', () => {
    // The same floor the subscription scan carries, for the same reason: if the
    // regex above silently stopped matching, the assertion before this one
    // would pass over an empty map and the guard would fail exactly the way the
    // thing it guards fails. Named rather than counted, because there are two.
    const widened = widenedReplicaIdentity();
    for (const table of ALLOWED) {
      expect(widened.get(table), `${table} should be FULL — see 00120`).toBe('FULL');
    }
  });

  it('never widens players, whatever else it widens', () => {
    // THE SAME TABLE AS EVER, AND A SECOND LOCK ON IT. `players` is not
    // published, so this is unreachable today — which is why it is worth
    // asserting now rather than after somebody publishes it for a roster badge.
    //
    // 00032 did not change the players_select policy; it REVOKED table-level
    // SELECT and re-granted a column whitelist, and logical replication honours
    // neither column grants nor RLS. FULL on `players` would stream `email` and
    // `phone` out of every deleted or updated row, through a channel that
    // consults no grant.
    expect([...widenedReplicaIdentity().keys()]).not.toContain('players');
  });

  it('never widens a table that still carries an exec\'s free text', () => {
    // THE ASSERTION 00117 AND 00118 ACTUALLY DEPEND ON, and the reason this
    // whole describe block exists.
    //
    // Those two migrations moved four columns of exec-written free text —
    // withdrawal reasons, disqualification reasons, void reasons, walkover
    // verdicts — into private tables with no grant for `authenticated` and RLS
    // on with no policy. THEY DID NOT DROP THE ORIGINAL COLUMNS. 00118's header
    // explains why and writes out the follow-up DROP for a later hand, so
    // `tournament_participants.notes`, `tournament_pairs.notes` and
    // `tournament_matches.notes` are all still there and still hold every note
    // written before the sweep ran. `matches.admin_note` likewise, per 00117.
    //
    // ALL FOUR PARENTS ARE PUBLISHED (00113, 00114). FULL on any of them would
    // put that text on the wire in the DELETE path — a member's phone watching
    // a bracket receiving the reason an exec disqualified somebody, in the one
    // path where it does not travel today. That is the precise thing 00120
    // declined to do, and the reason it reached for a parent-touching trigger
    // instead of the one-line change.
    //
    // `tournament_pairs` is named for a second reason of its own: `pair_name`
    // is member-chosen and, per 00113:88, often a real name.
    //
    // THIS LIST SHRINKS ONLY WHEN THE COLUMNS ARE DROPPED, not when a reader
    // decides the notes have moved. Moved is not gone.
    const widened = [...widenedReplicaIdentity().keys()];
    for (const table of [
      'tournament_participants',
      'tournament_pairs',
      'tournament_matches',
      'matches',
    ]) {
      expect(widened, `${table} still carries free text — see 00117, 00118`).not.toContain(table);
    }
  });

  it('never widens a private note table either', () => {
    // BELT AND BRACES, and cheap. None of these six is published, so a widened
    // replica identity on one emits nothing today. The assertion is here so
    // that the two locks cannot be picked one at a time — a future migration
    // that publishes one of these for a console badge would otherwise find the
    // widening already in place and waiting.
    const widened = [...widenedReplicaIdentity().keys()];
    for (const table of [
      'match_admin_notes',
      'tournament_participant_notes',
      'tournament_pair_notes',
      'tournament_match_notes',
      'walkover_admin_notes',
      'varsity_notes',
    ]) {
      expect(widened, `${table} must never have a widened replica identity`).not.toContain(table);
    }
  });
});

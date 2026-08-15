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

  it('never publishes match_admin_notes, whatever else it publishes', () => {
    // THE SECOND INVERSE GUARD, and the one this app has the most to lose from.
    // Deliberately duplicated from the console's suite, on the same reasoning
    // the header gives for duplicating the whole file: each app defends its own
    // tree and the migration set is edited from both.
    //
    // `matches` IS published (00114), and that file wrote down honestly that
    // `admin_note` — the exec's own words about a void or a demotion — therefore
    // streams verbatim to every signed-in subscriber. THE SUBSCRIBERS ARE THIS
    // APP'S: /feed, /my-stats, /challenges and one challenge, all four of them
    // members' phones. 00117 moves that text to `match_admin_notes`, which
    // holds no grant for `authenticated` and has RLS on with no policy.
    //
    // Publishing it would hand it all straight back, because logical
    // replication consults neither the grant nor the policy — the exact
    // mechanism that keeps `players` off this list forever. Nothing in this app
    // subscribes to the table, nothing may, and no member should ever be able
    // to open a socket for it.
    expect(publishedTables()).not.toContain('match_admin_notes');
  });

  it('never publishes any of 00118\'s private note tables, whatever else it publishes', () => {
    // THE SAME GUARD FOR THE OTHER FOUR COLUMNS, and this app is again the one
    // with the most to lose: /tournaments subscribes to tournament_events,
    // tournament_matches, tournament_participants and tournament_pairs
    // (live-tournament.tsx), all four published by 00113 — so until 00118 the
    // reason an exec withdrew, disqualified or voided somebody streamed to the
    // phone of every member watching the bracket, including the member it was
    // written about.
    //
    // NONE OF THESE FOUR TABLES MAY EVER JOIN THEM. Their parents stay
    // published, because that is what makes the bracket live; moving the text
    // out is the entire fix, and one ALTER PUBLICATION would reverse it without
    // any screen looking different. Logical replication consults neither the
    // grant nor the RLS policy — the mechanism that keeps `players` off this
    // list forever.
    //
    // walkover_admin_notes is the one whose parent is NOT published today, and
    // it is listed anyway: 00005's walkovers_select already admits the
    // forfeiting player, so a future migration publishing `walkovers` would be
    // a short step, and this line makes sure the exec's verdict on that forfeit
    // does not travel with it.
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
// screen. FULL makes the filter evaluable and closes that gap in one statement,
// on any table, and the person reaching for it is fixing something real. It is
// the right answer on a table of ids and timestamps and the wrong one on a
// table carrying an exec's private note, and nothing about the statement itself
// says which.
//
// SO THE LIST IS PINNED BY NAME. Adding a table here is a deliberate act that
// has to survive review, which is the whole of what a text-scanning guard can
// offer and is exactly what it offered for the publication.
//
// DELIBERATELY DUPLICATED into the console's copy of this file, on the same
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

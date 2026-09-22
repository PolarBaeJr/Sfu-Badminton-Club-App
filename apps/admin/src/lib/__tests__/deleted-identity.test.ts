import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDITABLE_COLUMNS, WITHHELD_COLUMNS, auditablePlayer } from '../auditable-player';

// FIX-LIST #17 — "deletion leaves identity in four places".
//
// The four are: auth.audit_log_entries (730 prod rows carrying the real email
// in payload.actor_username), public.audit_logs.old_value (26 prod rows holding
// an address), the deletion_requested_at tombstone, and free text nobody swept.
// The first is `auth`-schema and unreachable from the app — migration 00155
// hands it over. The tombstone is deliberately kept and the purge job says why.
// This file covers the two halves that ARE app code:
//
//   1. The purge jobs' anonymising field list, which had been missing
//      `exec_photo_url` and `handle` — a photo of the person and the one name
//      they chose, both public, both promised erased.
//   2. The four admin actions that wrote a whole `select('*')` player row into
//      a permanent audit table.
//
// The pinning tests are the point. Both halves failed the same way — a list
// maintained by hand fell behind the table it describes — so the tests check
// the lists against the table rather than against a fixture.

const REPO = join(__dirname, '../../../../..');
const ANONYMIZE = join(REPO, 'supabase/functions/_shared/anonymize.ts');
const GEN_TYPES = join(REPO, 'packages/shared/src/types/database.gen.ts');

/** Every column `players` actually has, read from the generated types. */
function playerColumns(): string[] {
  const src = readFileSync(GEN_TYPES, 'utf8');
  const start = src.indexOf('      players: {');
  expect(start, 'players table not found in database.gen.ts').toBeGreaterThan(-1);
  const seg = src.slice(start, start + 8000);
  const row = seg.slice(seg.indexOf('Row: {'), seg.indexOf('Insert: {'));
  const cols = [...row.matchAll(/^\s{10}([a-z_]+):/gm)].map((m) => m[1] as string);
  expect(cols.length).toBeGreaterThan(30);
  // 00130 added exec_bio and the generated types have not been regenerated
  // since. It is a real column — both purge jobs write it — so it counts.
  return cols.includes('exec_bio') ? cols : [...cols, 'exec_bio'];
}

/** The list the purge jobs erase, read from the file both of them import. */
function identityColumns(): string[] {
  const src = readFileSync(ANONYMIZE, 'utf8');
  const block = src.slice(src.indexOf('export const IDENTITY_COLUMNS'));
  const arr = block.slice(block.indexOf('['), block.indexOf(']'));
  return [...arr.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
}

describe('a purged member keeps nothing that says who they were', () => {
  it('erases the exec photo and the handle, not only the avatar and the bio', () => {
    // The two the hand-maintained lists had missed. `exec_photo_url` is a
    // photograph on /exec that survived 00130's careful bio split; `handle` is
    // "the member's ONE chosen name" (00092), public and searchable, so leaving
    // it attached to a row now called Deleted Player defeats the whole erasure.
    const identity = identityColumns();
    expect(identity).toContain('exec_photo_url');
    expect(identity).toContain('handle');
    expect(identity).toContain('avatar_url');
    expect(identity).toContain('bio');
    expect(identity).toContain('exec_bio');
  });

  it('writes every column it claims to erase', () => {
    // The list and the update are two things in one file, and a name in the
    // list that is not in the update erases nothing.
    const src = readFileSync(ANONYMIZE, 'utf8');
    const body = src.slice(src.indexOf('export function anonymizedPlayerFields'));
    for (const col of identityColumns()) {
      expect(body, `${col} is listed as identity but never written`).toMatch(
        new RegExp(`\\b${col}:`),
      );
    }
  });

  it('never writes full_name, which is generated', () => {
    // Writing it raises "column full_name can only be updated to DEFAULT" and
    // takes the whole UPDATE down — after the auth user has already been
    // deleted. The prod copy of purge-deleted-accounts once had exactly this.
    const src = readFileSync(ANONYMIZE, 'utf8');
    const body = src.slice(src.indexOf('export function anonymizedPlayerFields'));
    expect(body).not.toMatch(/\bfull_name:/);
  });

  it('is the only place either purge job decides what to erase', () => {
    // Both jobs used to carry their own copy, which is how the two missing
    // columns went unnoticed through two careful reviews of one of them.
    for (const job of ['purge-deleted-accounts', 'purge-inactive-accounts']) {
      const src = readFileSync(join(REPO, `supabase/functions/${job}/index.ts`), 'utf8');
      expect(src, `${job} should import the shared field list`).toContain(
        "from '../_shared/anonymize.ts'",
      );
      expect(src, `${job} should not hand-build the anonymising update`).not.toMatch(
        /first_name:\s*'Deleted'/,
      );
    }
  });
});

describe('an audit row records standing, not identity', () => {
  const FULL_ROW = {
    id: 'p1', email: 'kiera@sfu.ca', phone: '+16045550101',
    first_name: 'Kiera', last_name: 'Tan', full_name: 'Kiera Tan',
    display_name: 'Kiera', handle: 'kiera', avatar_url: 'https://cdn/a.jpg',
    exec_photo_url: 'https://cdn/e.jpg', bio: 'I play left-handed.',
    exec_bio: 'VP Competitive since 2024.', user_id: 'u1',
    notification_preferences: { email: true },
    status: 'active', role: 'player', is_banned: true, ban_reason: 'No-shows',
    is_exec: false, active_flag: true, fee_exempt: false,
  };

  it('drops every identifying field', () => {
    const kept = auditablePlayer(FULL_ROW);
    const serialised = JSON.stringify(kept);
    for (const value of ['kiera@sfu.ca', '+16045550101', 'Kiera', 'Tan',
                         'cdn/a.jpg', 'cdn/e.jpg', 'left-handed', 'VP Competitive']) {
      expect(serialised, `${value} survived into the audit row`).not.toContain(value);
    }
    expect(kept).not.toHaveProperty('email');
    expect(kept).not.toHaveProperty('user_id');
  });

  it('keeps what the act was actually about', () => {
    // Without this, "drops everything" would pass and the audit trail would be
    // useless — an exec reading why somebody was banned needs the ban.
    const kept = auditablePlayer(FULL_ROW);
    expect(kept).toMatchObject({
      id: 'p1', status: 'active', role: 'player',
      is_banned: true, ban_reason: 'No-shows', active_flag: true,
    });
  });

  it('leaves absent keys absent rather than inventing nulls', () => {
    expect(auditablePlayer({ id: 'p1', status: 'active' })).toEqual({ id: 'p1', status: 'active' });
    expect(auditablePlayer(null)).toBeNull();
  });

  it('classifies every column the players table has', () => {
    // The pin. A new column on `players` is neither kept nor withheld until
    // somebody decides which, and this fails until they do — which is the
    // check that was missing when exec_photo_url was added.
    const classified = new Set<string>([...AUDITABLE_COLUMNS, ...WITHHELD_COLUMNS]);
    const unclassified = playerColumns().filter((c) => !classified.has(c));
    expect(unclassified, 'new players column(s) not classified in auditable-player.ts').toEqual([]);
  });

  it('agrees with the purge about what identity is', () => {
    // Two lists in two apps describing the same idea. They may differ in
    // exactly one way: full_name is identity but cannot be WRITTEN, so the
    // purge erases it via first_name/last_name instead of naming it.
    const withheld = new Set<string>(WITHHELD_COLUMNS);
    const purgeOnly = identityColumns().filter((c) => !withheld.has(c));
    expect(purgeOnly, 'the purge erases something the audit row still keeps').toEqual([]);

    const auditOnly = [...WITHHELD_COLUMNS].filter((c) => !identityColumns().includes(c));
    expect(auditOnly.sort()).toEqual(['full_name', 'notification_preferences']);
  });
});

describe('no admin action writes a raw player row to the audit log', () => {
  const SITES = ['actions/players.ts', 'actions/permissions.ts'];

  it('every audit write of a player row goes through auditablePlayer', () => {
    // The scan is what stops a fifth site. `select('*')` on players is the
    // shape that makes this easy to get wrong, and it is used at all four.
    //
    // What it looks for is the row passed WHOLE — `oldPlayer` with nothing
    // after it. `oldPlayer?.waiver_reset_at` is a named field the caller chose
    // and is not this bug; a first version of this scan flagged it, which is
    // the false positive that would have made the test noise rather than a
    // gate.
    const offenders: string[] = [];
    for (const rel of SITES) {
      const src = readFileSync(join(__dirname, '..', rel), 'utf8');
      for (const m of src.matchAll(/old_value:\s*([^\n]+)/g)) {
        const value = m[1] ?? '';
        if (/\boldPlayer\b(?!\s*\??\.)/.test(value) && !value.includes('auditablePlayer(')) {
          offenders.push(`${rel}: ${value.trim()}`);
        }
      }
    }
    expect(
      offenders,
      'a whole player row is being written to audit_logs — wrap it in auditablePlayer()',
    ).toEqual([]);
  });
});

describe('a purged member keeps no artifact that was only ever theirs', () => {
  /**
   * Every `player_id`-keyed table in the schema, read from the migrations
   * rather than from a list somebody maintains.
   */
  function playerKeyedTables(): string[] {
    const dir = join(REPO, 'supabase/migrations');
    const found = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const src = readFileSync(join(dir, file), 'utf8');
      for (const m of src.matchAll(
        /CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?([a-z_0-9]+)\s*\(([\s\S]*?)\n\)\s*;/gi,
      )) {
        if (/^\s*player_id\b/m.test(m[2] ?? '')) found.add(m[1] as string);
      }
    }
    expect(found.size, 'no player_id tables parsed, the regex has rotted').toBeGreaterThan(20);
    return [...found].sort();
  }

  /**
   * A named list from _shared/anonymize.ts.
   *
   * Ends the slice on `] as const` rather than on the first `]`. The comments
   * in that file cite route paths, and `/api/calendar/[token]` closed the array
   * early: the parser returned the first four tables, silently, and the pin
   * below passed for the wrong reason. Exactly the failure these tests exist to
   * make loud, so the fix is pinned by the length assertion too.
   */
  function sharedList(name: string): string[] {
    const src = readFileSync(ANONYMIZE, 'utf8');
    const block = src.slice(src.indexOf(`export const ${name}`));
    const end = block.indexOf('] as const');
    expect(end, `${name} should be a list ending in "] as const"`).toBeGreaterThan(-1);
    // Drop comment lines before matching rather than anchoring on layout: one
    // of these lists is multi-line with a comment per entry and the other is a
    // single line, so any rule about where a name sits is wrong for one of them.
    const arr = block
      .slice(block.indexOf('['), end)
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    const names = [...arr.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
    expect(names.length, `${name} parsed as empty`).toBeGreaterThan(0);
    return names;
  }

  // Why each player-keyed table the purge does NOT clear is allowed to stay.
  //
  // A reason per table, rather than a bare allowlist, because the two bugs this
  // file exists for were both "nobody looked at that one". Writing the sentence
  // is the review. Most of these come down to one of two things: the row is
  // also somebody ELSE's record, or it is a record the club has to keep.
  const KEPT: Record<string, string> = {
    announcement_reads: 'the club\'s record of who has seen a notice; no identity in the row',
    challenge_participants: 'a challenge has two players and the row is both their record',
    club_fees: 'a financial record, kept for the same reason a receipt is',
    digest_deliveries: 'the delivery key that stops a digest sending twice; activity, not identity',
    event_feedback: 'written about a club event, and part of the record of that event',
    event_waiver_acceptances: 'legal evidence, per tournament',
    legacy_tournament_participants: 'shared competitive history',
    match_participants: 'a match has two to four players',
    ratings: 'derived from matches other members played, and their Elo depends on it',
    reinstatement_fees: 'a financial record of a reinstatement the club processed',
    reliability_metrics: 'derived attendance, referenced by other members\' no-show handling',
    season_final_ratings: 'historical standings that other members appear in',
    season_snapshots: 'historical standings, and the input to season comparisons',
    session_attendance: 'who was at a session, which is every attendee\'s record',
    session_rsvp: 'the club\'s operational record of a session',
    tournament_fees: 'a financial record of an entry the member paid for',
    tournament_participants: 'shared competitive history, draws and results',
    // NOT SETTLED, and deliberately recorded as unsettled rather than quietly
    // kept. `varsity_notes.note` is free text an exec wrote ABOUT this member,
    // so it is plainly information about the person, and an argument for
    // clearing it is easy to make. It is kept for now because the club runs
    // under SFU Recreation: FIPPA brings a records retention schedule with it,
    // and under a schedule deleting early is its own breach. Erasing on a guess
    // is the one move that cannot be undone. See docs/design/open-issues.md
    // Part 10.6.
    varsity_notes: 'OPEN: free text about the member, held pending the records-schedule answer',
    waiver_acceptances: 'legal evidence, and the reason the table is append-only',
  };

  it('classifies every player-keyed table as cleared, unlinked or kept', () => {
    // THE PIN, and the check that was missing when player_discord_links was
    // added. A new table keyed on player_id is neither cleared nor justified
    // until somebody says which, and this fails until they do.
    const handled = new Set<string>([
      ...sharedList('PERSONAL_ARTIFACT_TABLES'),
      ...sharedList('DELINKED_TABLES'),
      ...Object.keys(KEPT),
    ]);
    const unclassified = playerKeyedTables().filter((t) => !handled.has(t));
    expect(
      unclassified,
      'new player_id table(s): add to PERSONAL_ARTIFACT_TABLES, DELINKED_TABLES, or KEPT with a reason',
    ).toEqual([]);
  });

  it('gives every kept table a real reason', () => {
    for (const [table, reason] of Object.entries(KEPT)) {
      expect(reason.length, `${table} needs a reason, not a placeholder`).toBeGreaterThan(20);
    }
  });

  it('clears the Discord link and the calendar token', () => {
    // The two that re-identify a purged member. The Discord link maps the row
    // to a live snowflake anyone holding it can read through; the calendar token
    // IS the authentication for that member's feed.
    const cleared = sharedList('PERSONAL_ARTIFACT_TABLES');
    expect(cleared).toContain('player_discord_links');
    expect(cleared).toContain('calendar_feed_tokens');
    expect(cleared).toContain('push_subscriptions');
    expect(cleared).toContain('passkey_credentials');
  });

  it('does not clear a table that belongs to a second member', () => {
    // The inverse failure, and the more damaging one: clearing session
    // attendance or match participation would rewrite other members' history
    // and silently change their Elo. Nothing in the shared lists may name a
    // table justified as shared.
    const cleared = new Set<string>([
      ...sharedList('PERSONAL_ARTIFACT_TABLES'),
      ...sharedList('DELINKED_TABLES'),
    ]);
    const overlap = Object.keys(KEPT).filter((t) => cleared.has(t));
    expect(overlap, 'a table is both kept and cleared, so one of the two is wrong').toEqual([]);
  });

  it('is the only place either purge job decides which tables to touch', () => {
    for (const job of ['purge-deleted-accounts', 'purge-inactive-accounts']) {
      const src = readFileSync(join(REPO, `supabase/functions/${job}/index.ts`), 'utf8');
      expect(src, `${job} should iterate the shared table list`).toContain(
        'for (const table of PERSONAL_ARTIFACT_TABLES)',
      );
      expect(src, `${job} should honour the declared SET NULL`).toContain(
        'for (const table of DELINKED_TABLES)',
      );
      // The shape the shared list replaced. A reintroduced literal is how the
      // lists drifted apart the first time.
      expect(src, `${job} should not name artifact tables inline`).not.toMatch(
        /from\('push_subscriptions'\)/,
      );
    }
  });

  it('scrubs the audit trails once after the loop, never inside it', () => {
    // scrub_deleted_identity() takes no arguments and finds its work by two
    // predicates that only hold once the loop has finished: an auth row whose
    // actor is gone from auth.users, and a players row with user_id NULL and a
    // deleted+ sentinel email. Called per player before the anonymising update
    // it matches nothing, scrubs nothing, and reports success.
    for (const job of ['purge-deleted-accounts', 'purge-inactive-accounts']) {
      const src = readFileSync(join(REPO, `supabase/functions/${job}/index.ts`), 'utf8');
      expect(src, `${job} should call the scrub`).toContain("rpc('scrub_deleted_identity')");
      const loopStart = src.indexOf('for (const player of');
      const loopEnd = src.indexOf('\n  }\n', loopStart);
      const insideLoop = src.slice(loopStart, loopEnd);
      expect(
        insideLoop,
        `${job} calls scrub_deleted_identity inside the per-player loop, where it matches nothing`,
      ).not.toContain('scrub_deleted_identity');
    }
  });
});

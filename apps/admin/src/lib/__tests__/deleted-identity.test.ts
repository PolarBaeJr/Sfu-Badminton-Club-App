import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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

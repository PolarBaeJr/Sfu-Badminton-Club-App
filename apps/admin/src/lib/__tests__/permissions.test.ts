import { describe, it, expect } from 'vitest';
import { accessLevelFor, atLeast, canAccess, type AccessLevel } from '../permissions';

// This suite pins the console's access boundary now that there are THREE
// ordered levels — admin > exec > trainer. The middleware, the sidebar and every
// server page ask these functions, so a wrong answer here is a wrong answer
// everywhere at once.
//
// The club owner's rule for the new level: "a varsity trainer only has players
// and varsity notes."

const LEVELS: (AccessLevel | null)[] = ['admin', 'exec', 'trainer', null];

describe('accessLevelFor', () => {
  it('resolves the HIGHEST level held, so the markers compose', () => {
    expect(accessLevelFor({ role: 'admin' })).toBe('admin');
    expect(accessLevelFor({ role: 'player', is_exec: true })).toBe('exec');
    expect(accessLevelFor({ role: 'player', is_trainer: true })).toBe('trainer');
    // An admin or exec who is ALSO a trainer keeps the higher level. This is the
    // composition rule: the restriction applies to the level someone resolves
    // to, never to a flag in isolation.
    expect(accessLevelFor({ role: 'admin', is_trainer: true })).toBe('admin');
    expect(accessLevelFor({ role: 'admin', is_exec: true, is_trainer: true })).toBe('admin');
    expect(accessLevelFor({ role: 'player', is_exec: true, is_trainer: true })).toBe('exec');
  });

  it('gives an ordinary member no level at all', () => {
    expect(accessLevelFor({ role: 'player' })).toBeNull();
    expect(accessLevelFor({ role: 'player', is_exec: false, is_trainer: false })).toBeNull();
    expect(accessLevelFor(null)).toBeNull();
    expect(accessLevelFor(undefined)).toBeNull();
  });

  // The SQL function admin_access_level() (migration 00054) returns these exact
  // strings and the middleware feeds them straight into canAccess(). A drift
  // between the two spellings resolves to null, fails closed, and locks the
  // level out with no error surfaced anywhere — so pin the literals.
  it('returns exactly the strings admin_access_level() returns', () => {
    expect(accessLevelFor({ role: 'admin' })).toBe('admin');
    expect(accessLevelFor({ is_exec: true })).toBe('exec');
    expect(accessLevelFor({ is_trainer: true })).toBe('trainer');
  });
});

describe('atLeast', () => {
  it('orders admin > exec > trainer', () => {
    expect(atLeast('admin', 'trainer')).toBe(true);
    expect(atLeast('admin', 'exec')).toBe(true);
    expect(atLeast('admin', 'admin')).toBe(true);
    expect(atLeast('exec', 'trainer')).toBe(true);
    expect(atLeast('exec', 'exec')).toBe(true);
    expect(atLeast('exec', 'admin')).toBe(false);
    expect(atLeast('trainer', 'trainer')).toBe(true);
    expect(atLeast('trainer', 'exec')).toBe(false);
    expect(atLeast('trainer', 'admin')).toBe(false);
  });

  it('treats no level as reaching nothing', () => {
    expect(atLeast(null, 'trainer')).toBe(false);
    expect(atLeast(undefined, 'trainer')).toBe(false);
  });
});

// The full matrix, written out rather than derived, so a change to
// SECTION_ACCESS has to be made here too and cannot pass silently.
const MATRIX: { path: string; admin: boolean; exec: boolean; trainer: boolean }[] = [
  // The trainer's two sections. /players so they can find the person they are
  // writing about; /settings so they can enrol their own passkeys; /dashboard
  // because that is where sign-in lands.
  { path: '/players', admin: true, exec: true, trainer: true },
  { path: '/players/abc-123', admin: true, exec: true, trainer: true },
  { path: '/settings', admin: true, exec: true, trainer: true },
  { path: '/dashboard', admin: true, exec: true, trainer: true },
  { path: '/api/passkey/register/options', admin: true, exec: true, trainer: true },

  // Exec territory. Explicitly NOT the trainer's — the club owner's list was
  // players and varsity notes, nothing else.
  { path: '/matches', admin: true, exec: true, trainer: false },
  { path: '/tournaments', admin: true, exec: true, trainer: false },
  { path: '/sessions', admin: true, exec: true, trainer: false },
  { path: '/seasons', admin: true, exec: true, trainer: false },
  { path: '/announcements', admin: true, exec: true, trainer: false },

  // Admin territory.
  { path: '/fees', admin: true, exec: false, trainer: false },
  { path: '/audit', admin: true, exec: false, trainer: false },
  { path: '/disputes', admin: true, exec: false, trainer: false },
  { path: '/walkovers', admin: true, exec: false, trainer: false },
  { path: '/challenges', admin: true, exec: false, trainer: false },
  // Admin-only sub-route under an exec-allowed section.
  { path: '/tournaments/abc-123/fees', admin: true, exec: false, trainer: false },
];

describe('canAccess — three-level matrix', () => {
  for (const row of MATRIX) {
    it(`${row.path}: admin=${row.admin} exec=${row.exec} trainer=${row.trainer}`, () => {
      expect(canAccess('admin', row.path)).toBe(row.admin);
      expect(canAccess('exec', row.path)).toBe(row.exec);
      expect(canAccess('trainer', row.path)).toBe(row.trainer);
      // Nobody without a level gets in anywhere, ever.
      expect(canAccess(null, row.path)).toBe(false);
    });
  }

  it('never gives a lower level access a higher one lacks', () => {
    for (const row of MATRIX) {
      if (row.trainer) expect(row.exec).toBe(true);
      if (row.exec) expect(row.admin).toBe(true);
    }
  });

  // The default is the whole safety net: a section added to the app without a
  // SECTION_ACCESS entry must be admin-only, not open to the newest level.
  it('defaults unlisted paths to admin-only', () => {
    for (const path of ['/', '/some-new-section', '/players-lookalike', '/api/internal', '/settingsx']) {
      expect(canAccess('admin', path)).toBe(true);
      expect(canAccess('exec', path)).toBe(false);
      expect(canAccess('trainer', path)).toBe(false);
    }
  });

  // Prefix matching must be on path SEGMENTS. '/playersecret' starting with
  // '/players' would otherwise hand a trainer a section nobody meant them to see.
  it('matches on path segments, not string prefixes', () => {
    for (const level of LEVELS) {
      expect(canAccess(level, '/playersecret')).toBe(level === 'admin');
    }
  });
});

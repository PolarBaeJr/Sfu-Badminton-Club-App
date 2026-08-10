import { describe, it, expect } from 'vitest';
import {
  accessLevelFor,
  atLeast,
  canAccess,
  UNRESTRICTED,
  type AccessLevel,
} from '../permissions';

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

// THE ROUTE-EQUIVALENCE PROOF. The full matrix, written out rather than
// derived, so a change to the section map has to be made here too and cannot
// pass silently.
//
// Every row is UNCHANGED from before capabilities replaced the level column:
// canAccess now resolves a path to a capability namespace and asks whether the
// viewer holds a read beneath it, and this table is the assertion that the two
// formulations answer identically for an unrestricted person — which is
// everybody, on the day this ships.
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
  // Exec-reachable ONLY so an exec can record an expense they paid for out of
  // pocket ("allow execs to add expenses too"). This line is deliberately not
  // the whole boundary for this section — /fees/page.tsx skips the fetches
  // behind Club fees, Other income, reinstatements and the net-position strip
  // for anyone who is not an admin. Guarding it here as well would bounce the
  // exec off the Expenses tab too, which is the thing the club owner asked for.
  //
  // If this row is ever flipped back to exec:false, the sidebar entry must move
  // back into the admin-only group with it — an exec with a link that bounces
  // them is a bug that has shipped before.
  { path: '/fees', admin: true, exec: true, trainer: false },

  // Admin territory.
  { path: '/audit', admin: true, exec: false, trainer: false },
  { path: '/disputes', admin: true, exec: false, trainer: false },
  { path: '/walkovers', admin: true, exec: false, trainer: false },
  { path: '/challenges', admin: true, exec: false, trainer: false },
  // Platform configuration, split out of /settings. /settings itself stays
  // trainer-level for passkey enrolment, so these two MUST be listed
  // separately — the club owner's rule was that execs cannot edit them, and
  // there is no read-only view for them either.
  { path: '/ratings', admin: true, exec: false, trainer: false },
  { path: '/accounts', admin: true, exec: false, trainer: false },
  // Admin-only sub-route under an exec-allowed section.
  { path: '/tournaments/abc-123/fees', admin: true, exec: false, trainer: false },
];

describe('canAccess — three-level matrix', () => {
  for (const row of MATRIX) {
    it(`${row.path}: admin=${row.admin} exec=${row.exec} trainer=${row.trainer}`, () => {
      expect(canAccess('admin', UNRESTRICTED, row.path)).toBe(row.admin);
      expect(canAccess('exec', UNRESTRICTED, row.path)).toBe(row.exec);
      expect(canAccess('trainer', UNRESTRICTED, row.path)).toBe(row.trainer);
      // Nobody without a level gets in anywhere, ever.
      expect(canAccess(null, UNRESTRICTED, row.path)).toBe(false);
    });
  }

  it('never gives a lower level access a higher one lacks', () => {
    for (const row of MATRIX) {
      if (row.trainer) expect(row.exec).toBe(true);
      if (row.exec) expect(row.admin).toBe(true);
    }
  });

  // The default is the whole safety net: a section added to the app without a
  // section-map entry must be admin-only, not open to the newest level.
  it('defaults unlisted paths to admin-only', () => {
    for (const path of ['/some-new-section', '/players-lookalike', '/api/internal', '/settingsx']) {
      expect(canAccess('admin', UNRESTRICTED, path)).toBe(true);
      expect(canAccess('exec', UNRESTRICTED, path)).toBe(false);
      expect(canAccess('trainer', UNRESTRICTED, path)).toBe(false);
    }
  });

  // The console root only redirects to /dashboard, but middleware runs before
  // that redirect. It used to fall through to the admin-only default, so every
  // non-admin who opened /admin — where the player app's "Exec Panel" link
  // points — was bounced to /unauthorized. This case previously asserted the
  // opposite and so encoded the bug.
  it('lets every console level in the front door at /', () => {
    for (const level of ['admin', 'exec', 'trainer'] as AccessLevel[]) {
      expect(canAccess(level, UNRESTRICTED, '/')).toBe(true);
    }
    // Signed out is still signed out — the root is a front door, not an opening.
    expect(canAccess(null, UNRESTRICTED, '/')).toBe(false);
  });

  // '/' is listed, but it must match the root and NOTHING else — otherwise it
  // becomes a trainer-level catch-all that swallows the admin-only default.
  it('does not let the root entry widen any other path', () => {
    for (const path of ['/some-new-section', '/api/internal', '/players-lookalike']) {
      expect(canAccess('trainer', UNRESTRICTED, path)).toBe(false);
      expect(canAccess('exec', UNRESTRICTED, path)).toBe(false);
    }
  });

  // Prefix matching must be on path SEGMENTS. '/playersecret' starting with
  // '/players' would otherwise hand a trainer a section nobody meant them to see.
  it('matches on path segments, not string prefixes', () => {
    for (const level of LEVELS) {
      expect(canAccess(level, UNRESTRICTED, '/playersecret')).toBe(level === 'admin');
    }
  });
});

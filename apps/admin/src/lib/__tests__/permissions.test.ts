import { describe, it, expect } from 'vitest';
import {
  accessLevelFor,
  atLeast,
  canAccess,
  portfolioOf,
  PORTFOLIOS,
  type AccessLevel,
  type Portfolio,
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
      expect(canAccess('admin', null, row.path)).toBe(row.admin);
      expect(canAccess('exec', null, row.path)).toBe(row.exec);
      expect(canAccess('trainer', null, row.path)).toBe(row.trainer);
      // Nobody without a level gets in anywhere, ever.
      expect(canAccess(null, null, row.path)).toBe(false);
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
    for (const path of ['/some-new-section', '/players-lookalike', '/api/internal', '/settingsx']) {
      expect(canAccess('admin', null, path)).toBe(true);
      expect(canAccess('exec', null, path)).toBe(false);
      expect(canAccess('trainer', null, path)).toBe(false);
    }
  });

  // The console root only redirects to /dashboard, but middleware runs before
  // that redirect. It used to fall through to the admin-only default, so every
  // non-admin who opened /admin — where the player app's "Exec Panel" link
  // points — was bounced to /unauthorized. This case previously asserted the
  // opposite and so encoded the bug.
  it('lets every console level in the front door at /', () => {
    for (const level of ['admin', 'exec', 'trainer'] as AccessLevel[]) {
      expect(canAccess(level, null, '/')).toBe(true);
    }
    // Signed out is still signed out — the root is a front door, not an opening.
    expect(canAccess(null, null, '/')).toBe(false);
  });

  // '/' is listed, but it must match the root and NOTHING else — otherwise it
  // becomes a trainer-level catch-all that swallows the admin-only default.
  it('does not let the root entry widen any other path', () => {
    for (const path of ['/some-new-section', '/api/internal', '/players-lookalike']) {
      expect(canAccess('trainer', null, path)).toBe(false);
      expect(canAccess('exec', null, path)).toBe(false);
    }
  });

  // Prefix matching must be on path SEGMENTS. '/playersecret' starting with
  // '/players' would otherwise hand a trainer a section nobody meant them to see.
  it('matches on path segments, not string prefixes', () => {
    for (const level of LEVELS) {
      expect(canAccess(level, null, '/playersecret')).toBe(level === 'admin');
    }
  });
});

// ---------------------------------------------------------------------------
// The second axis: exec portfolios
// ---------------------------------------------------------------------------
// A portfolio NARROWS an exec and never widens anyone. The two properties that
// matter are opposites, and both are tested below: nobody loses anything when
// portfolio is null (the deploy-day guarantee), and a portfolio'd exec loses
// everything outside their own job (the reason the feature exists).

describe('canAccess — portfolios narrow an exec', () => {
  // THE DEPLOY-DAY GUARANTEE, checked against the whole matrix above rather
  // than a hand-picked path or two: every existing row has portfolio NULL, so
  // if any cell here disagreed with the three-level matrix, applying 00086
  // would have taken access away from a live user.
  it('changes nothing at all for an exec with no portfolio', () => {
    for (const row of MATRIX) {
      expect(canAccess('exec', null, row.path)).toBe(row.exec);
    }
  });

  // Admins are superusers. A portfolio on an admin is a value nothing reads —
  // setPlayerPortfolio refuses to store one — but if it ever landed there it
  // must not narrow them.
  it('never narrows an admin', () => {
    for (const row of MATRIX) {
      for (const portfolio of PORTFOLIOS) {
        expect(canAccess('admin', portfolio, row.path)).toBe(row.admin);
      }
    }
  });

  // What each portfolio opens. The finance VP being refused /tournaments and
  // the tournaments VP being refused /fees is the entire point: before this,
  // both could do both.
  const GRANTS: { portfolio: Portfolio; allowed: string[]; refused: string[] }[] = [
    {
      portfolio: 'finance',
      allowed: ['/fees'],
      refused: ['/tournaments', '/matches', '/sessions', '/players', '/seasons', '/legal', '/announcements'],
    },
    {
      portfolio: 'tournaments',
      allowed: ['/tournaments', '/tournaments/abc-123', '/matches', '/sessions'],
      refused: ['/fees', '/players', '/seasons', '/legal', '/announcements'],
    },
    {
      portfolio: 'internal',
      allowed: ['/players', '/players/abc-123', '/seasons'],
      refused: ['/fees', '/tournaments', '/matches', '/sessions', '/legal', '/announcements'],
    },
    {
      portfolio: 'external',
      allowed: ['/legal', '/announcements'],
      refused: ['/fees', '/tournaments', '/matches', '/sessions', '/players', '/seasons'],
    },
  ];

  for (const grant of GRANTS) {
    it(`the ${grant.portfolio} exec keeps only ${grant.allowed.join(', ')}`, () => {
      for (const path of grant.allowed) {
        expect(canAccess('exec', grant.portfolio, path)).toBe(true);
      }
      for (const path of grant.refused) {
        expect(canAccess('exec', grant.portfolio, path)).toBe(false);
      }
    });
  }

  // The baseline. Without it a portfolio would lock its holder out of the
  // console altogether — including out of enrolling the passkey the console
  // demands of them.
  it('keeps the baseline for every portfolio', () => {
    for (const portfolio of PORTFOLIOS) {
      for (const path of ['/', '/dashboard', '/settings', '/api/passkey/register/options']) {
        expect(canAccess('exec', portfolio, path)).toBe(true);
      }
    }
  });

  // ALLOW-LIST, not deny-list. A section added to SECTION_ACCESS without a
  // SECTION_PORTFOLIO entry must be refused to a portfolio'd exec — the
  // deny-list version of this rule would hand every future exec-level section
  // to all four portfolios, silently.
  it('refuses an exec-level section that no portfolio claims', () => {
    // Stand-ins for "a section somebody adds next year": unlisted paths, which
    // are admin-only for the same fail-closed reason.
    for (const portfolio of PORTFOLIOS) {
      for (const path of ['/some-new-section', '/api/internal']) {
        expect(canAccess('exec', portfolio, path)).toBe(false);
      }
    }
  });

  // A portfolio narrows; it must never reach past the level. Tournament money
  // is admin-only under an exec-allowed section, and the finance portfolio does
  // not open it (design open question 4).
  it('never widens: no portfolio reaches an admin-only section', () => {
    for (const portfolio of PORTFOLIOS) {
      for (const path of ['/audit', '/ratings', '/accounts', '/permissions', '/tournaments/abc-123/fees']) {
        expect(canAccess('exec', portfolio, path)).toBe(false);
      }
    }
  });

  // Documented consequence, pinned so it is a decision rather than a surprise:
  // /players is trainer-readable, but a portfolio'd exec is narrowed BELOW that
  // unless their portfolio is 'internal'. Reading the roster is PII, not a
  // baseline convenience, and the admin can always set the portfolio back to
  // none.
  it('narrows a portfolio’d exec out of the trainer-readable roster', () => {
    expect(canAccess('trainer', null, '/players')).toBe(true);
    expect(canAccess('exec', 'internal', '/players')).toBe(true);
    expect(canAccess('exec', 'finance', '/players')).toBe(false);
  });

  // An unrecognised portfolio grants nothing but the baseline. The CHECK
  // constraint in 00086 makes this unreachable; it is here because the safe
  // reading of a value nobody can interpret is "no sections", not "all of them".
  it('gives an unrecognised portfolio the baseline and nothing else', () => {
    const bogus = 'treasurer' as Portfolio;
    expect(canAccess('exec', bogus, '/dashboard')).toBe(true);
    expect(canAccess('exec', bogus, '/fees')).toBe(false);
    expect(canAccess('exec', bogus, '/tournaments')).toBe(false);
  });
});

describe('portfolioOf', () => {
  // The column does not exist until 00086 is applied, and this code deploys
  // first. A missing column must read as "not narrowed" — the alternative locks
  // every exec out of the console the moment the app ships.
  it('reads a missing or empty column as no portfolio', () => {
    expect(portfolioOf({})).toBeNull();
    expect(portfolioOf({ portfolio: null })).toBeNull();
    expect(portfolioOf({ portfolio: '' })).toBeNull();
    expect(portfolioOf(null)).toBeNull();
    expect(portfolioOf(undefined)).toBeNull();
  });

  it('passes a real portfolio through', () => {
    for (const portfolio of PORTFOLIOS) {
      expect(portfolioOf({ portfolio })).toBe(portfolio);
    }
  });

  // NOT normalised to null: that would be the fail-OPEN reading.
  it('does not turn an unrecognised value into full access', () => {
    expect(portfolioOf({ portfolio: 'treasurer' })).toBe('treasurer');
    expect(canAccess('exec', portfolioOf({ portfolio: 'treasurer' }), '/fees')).toBe(false);
  });
});

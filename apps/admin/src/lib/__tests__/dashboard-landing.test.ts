import { describe, it, expect } from 'vitest';
import { openableSections } from '../../components/nav-sections';
import { permits, resolvePermissions, UNRESTRICTED, type AccessLevel, type Capability } from '../permissions';

// WHO LANDS ON A BARE DASHBOARD, and what they are shown instead.
//
// The dashboard's panels are gated one capability at a time, which is correct
// and is not what this file is about: it is about the person for whom EVERY one
// of those answers is no. She holds fees.page, fees.expenses.read and
// fees.expenses.add.write — the Finance role — and no panel on the page asks
// for any of them, so she used to get a header and an empty screen, which looks
// exactly like the app being broken.
//
// TWO THINGS ARE PINNED HERE. First, that the narrowed branch is UNREACHABLE
// for anybody nobody narrowed: an unrestricted exec holds fees.expenses.read
// (it is in EXEC_BASELINE, and ROLE_DEFAULTS.finance is precisely that subset of
// it), so no capability separates the Finance role from an ordinary exec inside
// the fees area, and the new tiles can only be conditioned on the old ones being
// absent. Second, that the signpost is DERIVED — it enumerates the sections
// through the same canAccess() the sidebar and the middleware use, so a section
// added later appears in it with nothing to remember.
//
// TILE_GATES IS A HAND WRITE-DOWN of the flags at the top of dashboard/page.tsx,
// deliberately, in the same spirit as ./capability-equivalence.test.ts: deriving
// it from the page would make it pass by construction, and the page cannot be
// imported anyway. A panel added there needs its capability added here.
const TILE_GATES: Capability[] = [
  'players.read',            // Active Players
  'players.approve.write',   // Pending Approvals, and the panel under the banner
  'disputes.page',           // Open Disputes
  'walkovers.page',          // Pending Walkovers
  'matches.page',            // Recent Matches
  'tournaments.page',        // Tournaments
  'challenges.page',         // Active Challenges
  'fees.netposition.read',   // The net position card
];

const LEVELS: AccessLevel[] = ['admin', 'exec', 'trainer'];

/** The page's `hasTiles`: does ANY panel of the ordinary dashboard render? */
const hasTiles = (level: AccessLevel, role: string | null) =>
  TILE_GATES.some((capability) =>
    permits(level, role === null ? UNRESTRICTED : resolvePermissions(role, [], []), capability),
  );

/** What the signpost lists — the page drops /dashboard, being that page. */
const signpost = (level: AccessLevel, role: string | null) =>
  openableSections(level, role === null ? UNRESTRICTED : resolvePermissions(role, [], []))
    .map((item) => item.href)
    .filter((href) => href !== '/dashboard');

describe('the narrowed dashboard', () => {
  // THE DEPLOY-DAY GUARANTEE for this page: nothing new renders for anybody who
  // has not been narrowed, at any level. A trainer holds players.read, an exec
  // holds seven of these and an admin holds all of them.
  it('never fires for anybody nobody narrowed', () => {
    for (const level of LEVELS) {
      expect(hasTiles(level, null), level).toBe(true);
    }
  });

  // The exec this whole task is about.
  it('fires for the Finance role, whose every panel is somebody else\'s', () => {
    expect(hasTiles('exec', 'finance')).toBe(false);
  });

  // And for the External role, which reaches announcements and the legal
  // documents — neither of which the dashboard has ever had a panel for.
  it('fires for the External role too', () => {
    expect(hasTiles('exec', 'external')).toBe(false);
  });

  // The two roles that still land on a populated page, so the branch stays as
  // narrow as it claims to be.
  it('does not fire for roles that keep a panel', () => {
    expect(hasTiles('exec', 'tournaments')).toBe(true);
    expect(hasTiles('exec', 'internal')).toBe(true);
  });

  it('points the Finance role at the money section', () => {
    expect(signpost('exec', 'finance')).toEqual(['/fees', '/settings']);
  });

  it('points the External role at both of its sections', () => {
    expect(signpost('exec', 'external')).toEqual(['/announcements', '/legal', '/settings']);
  });

  // A hand-picked person with nothing granted still gets a link rather than a
  // blank card: /settings belongs to no area and every console user keeps it,
  // so the signpost can never itself be empty.
  it('still names a door for somebody granted nothing at all', () => {
    expect(signpost('exec', 'custom')).toEqual(['/settings']);
  });
});

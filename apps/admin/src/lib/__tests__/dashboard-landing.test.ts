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
//
// IT MUST BE KEPT IN STEP IN BOTH DIRECTIONS. A gate added to the page and not
// here lets a narrowed person fall into the signpost branch AND render a panel;
// a gate left here after its panel is deleted gives them hasTiles with nothing
// behind it, which is the blank screen the branch exists to prevent.
const TILE_GATES: Capability[] = [
  'players.read',            // Members + Active roster cells, and New this week
  'players.approve.write',   // Pending approvals, the panel and the alert clause
  'disputes.page',           // The open-disputes alert clause
  'walkovers.page',          // The pending-walkovers alert clause
  'matches.page',            // Matches logged, and Awaiting confirmation
  'sessions.page',           // Sessions this week, and the Tonight card
  'tournaments.page',        // In play · Tournaments
  'challenges.page',         // In play · Challenges
  'fees.netposition.read',   // The net position card
  'fees.clubfees.read',      // The Fees outstanding cell
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

  // WHICH FEE CHARTS CAN EVER APPEAR ON THE NARROWED LANDING — and it is two of
  // the four, by construction rather than by choice. `fees.clubfees.read` and
  // `fees.netposition.read` are both TILE_GATES, so anybody holding either is
  // already on the ordinary dashboard and their panels live in its right rail.
  // The narrowed branch can only ever draw the expense ledger and other income.
  //
  // This is not a style rule. The narrowed landing used to carry a "Club fees"
  // tile gated on fees.clubfees.read that could never render, for exactly this
  // reason; a chart added there under either capability below would be the same
  // dead code, and one added there under a capability NOT in TILE_GATES would
  // give a narrowed person a panel AND the signpost.
  it('can never reach the narrowed landing holding the dues or net-position read', () => {
    for (const capability of ['fees.clubfees.read', 'fees.netposition.read'] as Capability[]) {
      expect(TILE_GATES).toContain(capability);
    }
  });

  // And the two that CAN. Both are absent from TILE_GATES, so holding one takes
  // nobody off the narrowed landing — which is what makes an expense chart
  // there reachable for the Finance role at all.
  it('draws the expense and other-income ledgers there, which no tile claims', () => {
    for (const capability of ['fees.expenses.read', 'fees.otherincome.read'] as Capability[]) {
      expect(TILE_GATES).not.toContain(capability);
    }
    expect(permits('exec', resolvePermissions('finance', [], []), 'fees.expenses.read')).toBe(true);
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

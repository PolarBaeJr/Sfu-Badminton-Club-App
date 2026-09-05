import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE TWO PLAYER READS MUST STAY ONE, AND POST-LOGIN MUST STAY OUT OF IT.
 *
 * The root layout and the page under it both need the viewer's row. They used
 * to fetch it separately -- the layout with a hand-written column list, the page
 * through getCurrentPlayer()'s select('*') -- which are different URLs, so Next
 * could not memoize them and prod's Kong log carried both shapes on every
 * authenticated navigation. getViewer() is the single request-scoped read that
 * replaced them.
 *
 * WHY THIS FILE GREPS SOURCE INSTEAD OF CALLING THE FUNCTIONS, which is the
 * thing worth being upfront about: react's cache() only memoizes inside a React
 * server render. Under vitest there is no such context, so cache() passes every
 * call straight through -- a test that called getViewer() twice and counted the
 * queries would count two either way, and a test asserting getCurrentPlayer()
 * is NOT cached would pass even if somebody wrapped it in cache() tomorrow.
 * Both of those tests would be vacuous, so neither is written. The deduplication
 * itself is verified where it is real: `players?select=` in the Kong access log
 * for one authenticated page load.
 *
 * What IS checkable here is the shape the deduplication depends on, and both
 * halves of it are things a plausible edit would undo.
 */

const SRC = join(__dirname, '..', '..');
const read = (rel: string) => {
  const text = readFileSync(join(SRC, rel), 'utf8');
  // A path typo would otherwise make every assertion below pass on ''. Both
  // files are hundreds of lines; anything this short is not the file we meant.
  expect(text.length).toBeGreaterThan(2000);
  return text;
};

describe('the root layout does not fetch the player row itself', () => {
  const layout = read('app/layout.tsx');

  it('builds no players query of its own', () => {
    // The regression this exists for is somebody re-adding a bespoke select
    // here -- to pick up one extra column, say. It would look harmless and it
    // would quietly restore the second round trip on every page in the app,
    // because a different column list is a different URL.
    expect(layout).not.toMatch(/\.from\(\s*['"]players['"]\s*\)/);
  });

  it('goes through getViewer, not the service-role client', () => {
    expect(layout).toContain('getViewer()');
    // createServiceRoleClient was only ever here for that players select. If it
    // comes back, so has the query.
    expect(layout).not.toContain('createServiceRoleClient');
  });
});

describe('post-login keeps the UNCACHED read', () => {
  const postLogin = read('app/auth/post-login/page.tsx');

  it('calls getCurrentPlayer and never getViewer', () => {
    // It calls ensurePlayerRowForUser() first, which can CREATE the row. By
    // then the layout has already rendered and filled the request cache with
    // player: null. Switching this one call to getViewer() -- the obvious tidy,
    // since every other page now uses it -- would send a member claiming their
    // row on first sign-in to /onboarding on the strength of a lookup that ran
    // before the row existed. That failure is invisible to types and to every
    // other test in this suite.
    expect(postLogin).toContain('await getCurrentPlayer()');
    // The CALL, not the name: the comment beside that line names getViewer() to
    // explain why it is not used, and a bare substring check trips on its own
    // documentation.
    expect(postLogin).not.toMatch(/await getViewer\s*\(/);
  });

  it('still does the row-creating call before the read', () => {
    // The comment above is only true while this ordering holds; if the ensure
    // call ever moves or goes away, revisit whether the exception is still
    // earning its place.
    const ensure = postLogin.indexOf('ensurePlayerRowForUser(');
    const readAt = postLogin.indexOf('await getCurrentPlayer()');
    expect(ensure).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(ensure);
  });
});

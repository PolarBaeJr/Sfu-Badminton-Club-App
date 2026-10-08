import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { viewerMaySeeChallenge } from '../challenge-visibility';

// FIX-LIST #14 / member-privacy audit §2.6 — "a challenge note reaches members
// who are not in the match".
//
// The bug was an ABSENT check, which is the kind a test suite never catches by
// accident: /challenges/[id] fetched by id and rendered. So the assertions here
// are split in two. The first half pins the predicate — and the case that
// matters is `sees nothing of a challenge they are not in`, which is the one
// that FAILS against the old page (there was no predicate at all, so every
// viewer saw everything). The second half pins that the page still CALLS it,
// because a correct predicate nobody invokes is exactly the shape this bug had.

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const THIRD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('viewerMaySeeChallenge', () => {
  it('refuses a challenge the viewer is not in — the whole point', () => {
    expect(
      viewerMaySeeChallenge(
        { created_by: OTHER, challenge_participants: [{ player_id: OTHER }, { player_id: THIRD }] },
        ME,
      ),
    ).toBe(false);
  });

  it('admits the person who was challenged', () => {
    expect(
      viewerMaySeeChallenge(
        { created_by: OTHER, challenge_participants: [{ player_id: OTHER }, { player_id: ME }] },
        ME,
      ),
    ).toBe(true);
  });

  it('admits a doubles partner, who is neither creator nor opponent', () => {
    // createChallenge writes four rows for doubles: challenger, opponent,
    // partner, opponent_partner. A rule keyed on "creator or opponent" would
    // 404 the two partners out of a match they are playing in.
    expect(
      viewerMaySeeChallenge(
        {
          created_by: OTHER,
          challenge_participants: [
            { player_id: OTHER }, { player_id: THIRD }, { player_id: ME },
          ],
        },
        ME,
      ),
    ).toBe(true);
  });

  it('admits the creator of a challenge with no participant rows yet', () => {
    // The row is inserted before the participants are (actions/challenges.ts:
    // 52 then 100, the second on the service role). A participants-only rule
    // would 404 the creator out of their own challenge in that window, and
    // permanently if the second insert ever failed — leaving them no screen
    // from which to cancel it.
    expect(viewerMaySeeChallenge({ created_by: ME, challenge_participants: [] }, ME)).toBe(true);
    expect(viewerMaySeeChallenge({ created_by: ME, challenge_participants: null }, ME)).toBe(true);
  });

  it('refuses when there is no row and when there is no viewer', () => {
    expect(viewerMaySeeChallenge(null, ME)).toBe(false);
    expect(viewerMaySeeChallenge(undefined, ME)).toBe(false);
    expect(
      viewerMaySeeChallenge({ created_by: OTHER, challenge_participants: [{ player_id: OTHER }] }, null),
    ).toBe(false);
  });

  it('does not admit everyone when the embed came back as a bare object', () => {
    // PostgREST returns a to-one embed as an object rather than an array, and
    // a `.some` over a non-array would throw — or, guarded the lazy way with
    // `?? []`, silently admit nobody. Normalising is what keeps both shapes
    // answering the same question.
    expect(viewerMaySeeChallenge({ created_by: OTHER, challenge_participants: { player_id: ME } }, ME)).toBe(true);
    expect(viewerMaySeeChallenge({ created_by: OTHER, challenge_participants: { player_id: THIRD } }, ME)).toBe(false);
  });

  it('is not fooled by a null entry inside the embed', () => {
    expect(viewerMaySeeChallenge({ created_by: OTHER, challenge_participants: [null, { player_id: THIRD }] }, ME)).toBe(false);
  });

  it('refuses a viewer id that is undefined on both sides', () => {
    // `created_by === viewerId` with both undefined would be TRUE, which would
    // open every orphaned challenge to any request that lost its player id.
    expect(viewerMaySeeChallenge({ created_by: undefined, challenge_participants: [] }, undefined)).toBe(false);
  });
});

describe('the detail page actually calls it', () => {
  const PAGE = join(__dirname, '..', '..', 'app', 'challenges', '[id]', 'page.tsx');
  const src = readFileSync(PAGE, 'utf8');

  it('imports the predicate', () => {
    expect(src).toContain("from '@/lib/challenge-visibility'");
  });

  it('gates the notFound on it, not on existence alone', () => {
    // `if (!challenge) notFound()` is what the page had, and it passes any test
    // that only asks "does a missing challenge 404". The gate has to be on the
    // same statement, before anything is rendered.
    expect(src).toMatch(/if\s*\(!challenge\s*\|\|\s*!viewerMaySeeChallenge\(challenge,\s*player\.id\)\)\s*notFound\(\);/);
  });

  it('still selects the participant rows the predicate needs', () => {
    // The gate is only as good as its input: drop `challenge_participants`
    // from the select and every non-creator 404s out of their own challenge.
    expect(src).toContain('challenge_participants(');
  });
});

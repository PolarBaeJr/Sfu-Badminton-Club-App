import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_FEATURES_ENABLED } from '@badminton/shared/src/utils/features';
import { memberTourSteps } from '../tours/member-tour';
import { ONBOARDING_STEP_COPY } from '../onboarding-steps';

// THE CLUB'S COPY RULES for what a member reads during setup and the tour: no
// em dash and no emoji. The console's tour is checked in its own app
// (exec-tour.test.ts), so neither app's test reads the other's files.

const EM_DASH = /\u2014/;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

/**
 * The source with its comments removed, so what is left is code, string
 * literals and JSX text. The comments in these files already use em dashes and
 * are not copy. Only whole-line `//` comments are dropped, so a `//` inside a
 * string (a URL) survives.
 */
function withoutComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

// Every step either reader can be given: an approved member and a pending
// signup get different settings copy.
const base = { features: { ...ALL_FEATURES_ENABLED }, featureAccess: [], held: new Set<string>() };
const MEMBER_STEPS = [
  ...memberTourSteps({ ...base, approved: true }),
  ...memberTourSteps({ ...base, approved: false }),
];

const offending = (text: string) =>
  text.split('\n').filter((line) => EM_DASH.test(line) || PICTOGRAPH.test(line));

describe('tour and onboarding copy', () => {
  it('the member tour has no em dash and no emoji', () => {
    for (const step of MEMBER_STEPS) {
      for (const text of [step.title, step.body]) {
        expect(EM_DASH.test(text), `${step.id}: ${text}`).toBe(false);
        expect(PICTOGRAPH.test(text), `${step.id}: ${text}`).toBe(false);
      }
    }
  });

  it('the member tour names the Discord by its own domain, never discord.gg', () => {
    const all = MEMBER_STEPS.map((s) => s.body).join('\n');
    expect(all).toContain('discord.sfubadminton.com');
    expect(all).not.toContain('discord.gg');
  });

  it('the onboarding step copy has no em dash and no emoji', () => {
    for (const [id, copy] of Object.entries(ONBOARDING_STEP_COPY)) {
      for (const text of [copy.heading, copy.subheading]) {
        expect(EM_DASH.test(text), `${id}: ${text}`).toBe(false);
        expect(PICTOGRAPH.test(text), `${id}: ${text}`).toBe(false);
      }
    }
  });

  it('the onboarding page shows no em dash and no emoji', () => {
    const src = readFileSync(join(__dirname, '../../app/onboarding/page.tsx'), 'utf8');
    expect(offending(withoutComments(src))).toEqual([]);
  });

  it('the settings tour link shows no em dash and no emoji', () => {
    // Only the replay link: the rest of the settings page predates this rule.
    const src = readFileSync(join(__dirname, '../../app/settings/page.tsx'), 'utf8');
    const start = src.indexOf('href="/feed?tour=member"');
    expect(start, 'settings no longer links the tour replay').toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('</Link>', start));
    expect(offending(block)).toEqual([]);
  });

  it('the comment stripper keeps a URL inside a string', () => {
    expect(withoutComments("const u = 'https://example.com';\n// gone")).toBe(
      "const u = 'https://example.com';",
    );
  });
});

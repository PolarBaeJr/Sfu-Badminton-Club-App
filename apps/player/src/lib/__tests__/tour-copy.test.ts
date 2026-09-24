import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMBER_TOUR_STEPS } from '../tours/member-tour';

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

const offending = (text: string) =>
  text.split('\n').filter((line) => EM_DASH.test(line) || PICTOGRAPH.test(line));

describe('tour and onboarding copy', () => {
  it('the member tour has no em dash and no emoji', () => {
    for (const step of MEMBER_TOUR_STEPS) {
      for (const text of [step.title, step.body]) {
        expect(EM_DASH.test(text), `${step.id}: ${text}`).toBe(false);
        expect(PICTOGRAPH.test(text), `${step.id}: ${text}`).toBe(false);
      }
    }
  });

  it('the member tour names the Discord by its own domain, never discord.gg', () => {
    const all = MEMBER_TOUR_STEPS.map((s) => s.body).join('\n');
    expect(all).toContain('discord.sfubadminton.com');
    expect(all).not.toContain('discord.gg');
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

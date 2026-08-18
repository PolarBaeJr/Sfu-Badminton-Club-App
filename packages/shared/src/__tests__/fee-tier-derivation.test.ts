// THERE MUST BE EXACTLY ONE ANSWER TO "WHAT DOES THIS ENTRY COST".
//
// selectFeeTier has been membership-aware since the day it was written, and for
// most of that time it had exactly ONE production caller: ensureEntryFees. Every
// other surface quoted `tiers.find(t => t.is_default)` instead, so one number
// had two derivations and the screens disagreed with the ledger.
//
// On the live tournament the default tier is External at $25 while internal
// members are priced at $15. That spread showed up as: the fees table reading
// $15 off the ledger while the Mark Paid dialog opened on "External — $25.00"
// (one click stored $25 against somebody who owed $15); the admin tournaments
// index over-stating outstanding entry money by $10 a head; and the player
// tournament hero quoting an internal member $10 more than their own
// registration would write.
//
// Each of those was found separately, months apart, because nothing stopped the
// pattern coming back. This test is that stop. `is_default` is a real column and
// legitimately read to RENDER the default badge, to promote a tier, and inside
// selectFeeTier's own fallback — what is banned is picking a tier out of a list
// with it, which is the shape that means "I am pricing somebody without asking
// who they are".

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * Picking a tier OUT OF A COLLECTION using is_default — `.find(t => t.is_default)`,
 * `.filter(t => t.is_default)[0]`, `.some(...)` used as a selector. Deliberately
 * not matched: `.eq('is_default', true)` (a PostgREST filter, how the promote
 * action finds the row it must clear) and `tier.is_default &&` (a render test).
 */
const SELECTOR = /\.(find|filter)\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\2[?.]*\.is_default/;

/**
 * fee-tiers.ts IS the one derivation, so its own fallback is the point of the
 * file rather than a violation. The tests beside it model the old behaviour on
 * purpose, to prove the new one differs.
 */
const ALLOWED = [
  'packages/shared/src/utils/fee-tiers.ts',
  'packages/shared/src/utils/__tests__/fee-tiers.test.ts',
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // .claude/worktrees holds detached checkouts of other branches; scanning
    // them would fail this suite on code that is not on this branch.
    if (entry === 'node_modules' || entry === '.next' || entry === '.claude' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('fee tier derivation', () => {
  it('is never re-derived from is_default outside fee-tiers.ts', () => {
    const offenders: string[] = [];
    for (const dir of ['apps', 'packages']) {
      for (const file of sourceFiles(join(repoRoot, dir))) {
        const rel = file.slice(repoRoot.length);
        if (ALLOWED.includes(rel)) continue;
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          // Comments describe the banned shape on purpose — this file's own
          // header does, and so does the note at the fix site explaining what
          // the code used to say. Prose is not a derivation.
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (SELECTOR.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        });
      }
    }
    expect(
      offenders,
      `Pick the tier with quoteEntryFee(membership_type, tiers, feeRow) instead — ` +
        `it asks selectFeeTier, which is the rule the fee was actually written by:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

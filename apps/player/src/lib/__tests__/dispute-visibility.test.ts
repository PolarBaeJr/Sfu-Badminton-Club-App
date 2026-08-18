import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// FIX-LIST #13 — "dispute text reaches uninvolved players".
//
// `disputes_select` (00005_rls.sql:254) admits anyone in the match, which is
// four people in doubles, and the row carries a `reason_category` that includes
// 'abuse', the opener's free-text description, and the exec's written verdict.
// 00154 narrows it to the opener and the console.
//
// THERE IS NO APP CHANGE, and this file is the evidence for that claim rather
// than a substitute for one. The members' app contains no dispute screen at
// all — the entire feature is in the console, on the service role. What this
// asserts is that the precondition still holds: if a member-facing dispute view
// is ever added, it will read through a policy that no longer admits the whole
// court, and whoever adds it should find that out here rather than by shipping
// a screen that renders empty.

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

const SRC = join(__dirname, '..', '..');
const rel = (f: string) => f.slice(SRC.length + 1).replace(/\\/g, '/');

describe('the members\' app does not read the disputes table', () => {
  it('has no query against it anywhere', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.includes('__tests__')) continue;
      if (/from\('disputes'\)/.test(readFileSync(file, 'utf8'))) offenders.push(rel(file));
    }
    expect(
      offenders,
      'a members\' app screen now reads `disputes`. 00154 narrowed disputes_select to the ' +
      'opener and the console, so this read returns nothing for anyone else in the match — ' +
      'which is the point. Route it through an action on the service role, and decide ' +
      'deliberately what the person a dispute is ABOUT is entitled to see.',
    ).toEqual([]);
  });
});

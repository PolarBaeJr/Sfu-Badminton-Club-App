#!/usr/bin/env node
// supabase/ is not an npm workspace, so `turbo run test` never reaches
// supabase/functions/**. Deno cannot import @badminton/shared either, so
// supabase/functions/_shared/constants.ts is a hand-typed copy of a handful of
// values from packages/shared/src/utils/constants.ts. Nothing tested it and
// nothing compared it, which is exactly how a copy silently goes stale — and a
// stale DEFAULT_ELO means the season-compression cron regresses ratings toward
// the wrong baseline.
//
// This is a value comparison only: for every numeric constant the edge copy
// declares, the workspace must declare the same name with the same value.
//
// Lives in .github/ci/ rather than the conventional .github/scripts/ because
// the root .gitignore ignores `scripts/` at any depth (it is a local-only
// deploy/maintenance dir), which would silently keep this file out of the repo.
//
// KNOWN GAP, deliberately not attempted here: _shared/push.ts and
// _shared/settings.ts are *behavioural* mirrors (of packages/shared's
// push/send.ts, notifications.ts and tournament-bonuses.ts#settingNumber).
// Comparing those means comparing logic, not literals — a real job, best solved
// by giving the edge functions a Deno test suite rather than by a regex.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const EDGE = 'supabase/functions/_shared/constants.ts';
const SOURCE = 'packages/shared/src/utils/constants.ts';

/** Collect `export const NAME = <number>;` declarations, name -> literal text. */
function numericConstants(relPath) {
  const text = readFileSync(resolve(repoRoot, relPath), 'utf8');
  const found = new Map();
  const pattern = /^export const ([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(-?\d+(?:\.\d+)?)\s*;/gm;
  for (const m of text.matchAll(pattern)) found.set(m[1], m[2]);
  return found;
}

const edge = numericConstants(EDGE);
const source = numericConstants(SOURCE);

const problems = [];
for (const [name, edgeValue] of edge) {
  if (!source.has(name)) {
    problems.push(
      `${name}: declared in ${EDGE} as ${edgeValue}, but no such numeric constant in ${SOURCE} ` +
        `(renamed or removed upstream — the edge copy is now on its own)`,
    );
    continue;
  }
  const sourceValue = source.get(name);
  if (sourceValue !== edgeValue) {
    problems.push(`${name}: ${SOURCE} says ${sourceValue}, ${EDGE} says ${edgeValue}`);
  }
}

// A check that compares nothing passes trivially. If the regex stops matching —
// the files were reformatted, or a constant became a computed expression — that
// is a failure, not a pass, because the whole point is that nobody notices.
if (edge.size === 0) {
  problems.push(
    `no numeric constants parsed out of ${EDGE}. Either the file moved or its ` +
      `declaration style changed; update this script rather than deleting it.`,
  );
}

if (problems.length > 0) {
  console.error('Edge-function constants have drifted from packages/shared:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\nDeno cannot import the npm workspace, so these two files must be edited together.`,
  );
  process.exit(1);
}

console.log(`Edge-function constants match packages/shared (${edge.size} compared).`);

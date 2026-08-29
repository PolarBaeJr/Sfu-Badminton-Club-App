import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The entrant digest is built in TypeScript and compared in SQL. Nothing else
 * binds the two key sets together: `p_digests` is typed `Json` in
 * database.gen.ts, so `tsc` cannot see a renamed or dropped key, and every
 * behavioural test of the digest builds BOTH sides with jsonb_build_object,
 * which only proves SQL agrees with SQL.
 *
 * If the sets ever diverge, `publish_event_draw` returns 'entrant_changed' for
 * EVERY publication — Generate stops working entirely, for every event, with a
 * refusal that reads like a concurrency problem. This test is what catches
 * that at the point the rename is made rather than in live use.
 *
 * Parsed from source on both sides deliberately. brackets.ts is a 'use server'
 * module, so the builders cannot be exported to be called here: every export of
 * such a file is a client-reachable POST endpoint.
 */

const REPO = join(__dirname, '../../../../..');
const TS = readFileSync(
  join(REPO, 'apps/admin/src/lib/tournament-actions/brackets.ts'), 'utf8');
const SQL = readFileSync(
  join(REPO, 'supabase/migrations/00202_round10_field_defects.sql'), 'utf8');

/** Keys of the single object literal a named one-expression builder returns. */
function tsReturnKeys(fnName: string): string[] {
  const at = TS.indexOf(`function ${fnName}(`);
  expect(at, `${fnName} not found in brackets.ts`).toBeGreaterThan(-1);
  const ret = TS.indexOf('return {', at);
  expect(ret, `${fnName} has no object return`).toBeGreaterThan(-1);
  const end = TS.indexOf('};', ret);
  const body = TS.slice(ret + 'return {'.length, end);
  // Top-level keys only: `key:` at depth 0, plus a leading spread.
  const keys: string[] = [];
  let depth = 0;
  for (const part of body.split(',')) {
    const trimmed = part.trim();
    if (depth === 0) {
      const spread = /^\.\.\.\w+\.(\w+)$/.exec(trimmed);
      if (spread) keys.push(`...${spread[1]!}`);
      else {
        const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(trimmed);
        if (m) keys.push(m[1]!);
      }
    }
    for (const ch of part) {
      if (ch === '{' || ch === '(') depth++;
      if (ch === '}' || ch === ')') depth--;
    }
  }
  return keys;
}

/** Keys of the Nth jsonb_build_object inside publish_event_draw's comparison. */
function sqlDigestKeys(column: string): string[] {
  // Anchor on the join column so doubles and singles cannot be confused, and
  // so an accidental match against one of the many other jsonb_build_object
  // calls in the migration is impossible.
  const anchor = SQL.indexOf(`JOIN ${column}`);
  expect(anchor, `no JOIN ${column} in the digest comparison`).toBeGreaterThan(-1);
  const at = SQL.indexOf('jsonb_build_object', anchor);
  expect(at).toBeGreaterThan(-1);
  const open = SQL.indexOf('(', at);
  let depth = 0, i = open;
  for (; i < SQL.length; i++) {
    if (SQL[i] === '(') depth++;
    if (SQL[i] === ')') { depth--; if (depth === 0) break; }
  }
  const args = SQL.slice(open + 1, i);
  // jsonb_build_object takes alternating key, value — keys are the quoted
  // literals in even positions.
  return args.split(',').map((s) => s.trim())
    .filter((_, idx) => idx % 2 === 0)
    .map((s) => {
      const m = /^'([^']+)'$/.exec(s);
      expect(m, `non-literal digest key: ${s}`).not.toBeNull();
      return m![1]!;
    });
}

describe('publish_event_draw digest key contract', () => {
  it('the doubles digest TypeScript builds is the object SQL compares', () => {
    const identity = tsReturnKeys('doublesIdentity');
    const wrapper = tsReturnKeys('entrantDigest');
    expect(wrapper[0]).toBe('...identity');   // identity is spread, not nested
    const built = [...identity, ...wrapper.slice(1)];
    expect(built).toEqual(['p1', 'p2', 'ce', 'seed', 'grp']);
    expect(new Set(built)).toEqual(new Set(sqlDigestKeys('tournament_pairs pr')));
  });

  it('the singles digest TypeScript builds is the object SQL compares', () => {
    const identity = tsReturnKeys('singlesIdentity');
    const wrapper = tsReturnKeys('entrantDigest');
    const built = [...identity, ...wrapper.slice(1)];
    expect(built).toEqual(['p', 'eb', 'ea', 'seed', 'grp']);
    expect(new Set(built)).toEqual(new Set(sqlDigestKeys('tournament_participants tp')));
  });

  it('the two digests are distinguishable, so a doubles/singles mix-up refuses', () => {
    const d = new Set(sqlDigestKeys('tournament_pairs pr'));
    const s = new Set(sqlDigestKeys('tournament_participants tp'));
    expect(d).not.toEqual(s);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { onVisibleTracks } from '../session-track-filter';

// A PostgREST stub that behaves the way the REAL one does on this predicate,
// which is the whole reason this file exists rather than a "the query string
// contains X" assertion.
//
// Three behaviours, all of them load-bearing and all of them observed on prod:
//
//  1. `track` is an enum column, so a filter value outside `session_group` is
//     rejected at PLAN time — the query fails entirely, it does not match zero
//     rows.
//  2. PostgREST returns that as an HTTP 400.
//  3. supabase-js RESOLVES a 400 rather than rejecting, handing back
//     `{ data: null, error }`. That is the step that made the outage silent:
//     every call site wrote `?? []`, so a refused read and an empty club were
//     the same value.
//
// A stub that merely records filters would pass against the broken code, which
// is exactly what makes it worthless here.
const SESSION_GROUP = new Set(['competitive', 'recreational', 'all']);

type Row = { id: string; track: string };

function fakeSessions(rows: Row[]) {
  let filtered = rows;
  let refused: { code: string; message: string } | null = null;

  const builder: any = {
    in(column: string, values: string[]) {
      if (column === 'track') {
        for (const value of values) {
          if (!SESSION_GROUP.has(value)) {
            refused = {
              code: '22P02',
              message: `invalid input value for enum session_group: "${value}"`,
            };
            return builder;
          }
        }
        const wanted = new Set(values);
        filtered = filtered.filter((r) => wanted.has(r.track));
      }
      return builder;
    },
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        refused ? { data: null, error: refused } : { data: filtered, error: null },
      ).then(resolve),
  };
  return builder;
}

// Twelve open sessions across the three tracks — the prod shape the audit
// described, where a pending member was told "No sessions yet".
const SCHEDULE: Row[] = [
  ...Array.from({ length: 4 }, (_, i) => ({ id: `all-${i}`, track: 'all' })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `comp-${i}`, track: 'competitive' })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `rec-${i}`, track: 'recreational' })),
];

async function scheduleFor(status: string | null) {
  const res = (await onVisibleTracks(fakeSessions(SCHEDULE), status)) as {
    data: Row[] | null;
    error: { code: string } | null;
  };
  return res;
}

describe('the member schedule track filter', () => {
  // THE BUG, AS A BEHAVIOUR. Run against the pre-fix expression
  // `[player.status, 'all']` this fails on the first assertion with
  // `expected null not to be null` — the 22P02 the stub raises — and on the
  // second with `expected [] to have a length above 0`.
  it('gives a member waiting for approval a non-empty schedule', async () => {
    const { data, error } = await scheduleFor('pending_approval');
    expect(error).toBeNull();
    expect(data ?? []).not.toHaveLength(0);
  });

  it('gives a member waiting for approval every night the club runs', async () => {
    const { data } = await scheduleFor('pending_approval');
    expect(data).toHaveLength(SCHEDULE.length);
  });

  // The failure that would survive a mapping to ['all'] alone: the club tags a
  // night `competitive`, and a member with no track is shown a schedule that is
  // still missing it.
  it('does not hide a tracked night from a member who has no track', async () => {
    const { data } = await scheduleFor('pending_approval');
    expect((data ?? []).map((r) => r.track)).toContain('competitive');
    expect((data ?? []).map((r) => r.track)).toContain('recreational');
  });

  it('gives a suspended member the same non-empty schedule', async () => {
    const { data, error } = await scheduleFor('suspended');
    expect(error).toBeNull();
    expect(data ?? []).not.toHaveLength(0);
  });

  // The behaviour that must NOT have changed: a member who has a track still
  // gets their own nights and the club-wide ones, and not the other division's.
  it('still narrows a competitive member to their own nights plus club-wide', async () => {
    const { data } = await scheduleFor('competitive');
    const tracks = new Set((data ?? []).map((r) => r.track));
    expect(tracks).toEqual(new Set(['competitive', 'all']));
    expect(data).toHaveLength(8);
  });

  it('still narrows a recreational member the same way', async () => {
    const { data } = await scheduleFor('recreational');
    expect(new Set((data ?? []).map((r) => r.track))).toEqual(new Set(['recreational', 'all']));
  });

  it('survives a status column that was never selected', async () => {
    const { data, error } = await scheduleFor(null);
    expect(error).toBeNull();
    expect(data).toHaveLength(SCHEDULE.length);
  });
});

// ---------------------------------------------------------------------------
// THE STRUCTURAL GUARD
// ---------------------------------------------------------------------------
// A helper nobody is obliged to call does not stop a seventh call site being
// written by hand — and six were, independently, in three files. This is the
// assertion that makes "every session read goes through the mapping" a fact the
// suite checks rather than a convention somebody has to remember.

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

describe('the track filter has exactly one call site', () => {
  it("names 'track' in a PostgREST filter in session-track-filter.ts and nowhere else", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(__dirname, '..', '..'))) {
      // This file quotes the shape it is looking for, so it would find itself.
      if (file.includes('__tests__')) continue;
      const source = readFileSync(file, 'utf8');
      // `.in('track'` / `.in("track"` — the shape all six call sites had.
      if (/\.in\(\s*['"]track['"]/.test(source)) offenders.push(file);
    }
    expect(offenders.map((f) => f.replace(/^.*\/apps\/player\//, ''))).toEqual([
      'src/lib/session-track-filter.ts',
    ]);
  });

  // Belt: the raw status must never reach the filter again, under any spelling.
  it('never builds a track filter out of a player status', () => {
    for (const file of sourceFiles(join(__dirname, '..', '..'))) {
      // The helper and this file both QUOTE the broken shape in a comment, so
      // both would match themselves. Everything else is real code.
      if (/session-track-filter\.(ts|test\.ts)$/.test(file)) continue;
      const source = readFileSync(file, 'utf8');
      expect(/\[\s*(player|viewer|me)\.status\s*,\s*['"]all['"]\s*\]/.test(source), file).toBe(
        false,
      );
    }
  });
});

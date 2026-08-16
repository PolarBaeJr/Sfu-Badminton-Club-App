import { describe, it, expect, vi, beforeEach } from 'vitest';

// TWENTY SECONDS, FOR MODULE LOADING AND NOT FOR LOGIC.
//
// The three cases below assert the order of two array pushes. What is slow is
// the `await import('../actions/sessions')` inside each of them: that module
// reaches Supabase, next/cache, next/headers and session-reminders, and the
// whole of that graph has to be transformed and evaluated before the first
// assertion can run. The work is one-time and it is cheap on an idle machine —
// about a second for the file — but it lands INSIDE a test's own clock rather
// than in a hook, so the default 5s budget is being spent on `import` and not on
// anything this file is about.
//
// Under `turbo run test` several suites compete for cores and that import
// stretches with the contention, which is why this file passes alone and times
// out in a full run. Twenty is far outside that spread and still far inside
// "this test is hung"; the global default stays at 5s so a genuinely wedged test
// elsewhere is still caught quickly.
//
// PER-FILE, so it covers all three: vitest caches the module after the first
// `import()`, but the tests do not run in a guaranteed order under contention
// and any one of them can be the one that pays the load. Raising only the first
// would leave the flake exactly where it was.
vi.setConfig({ testTimeout: 20_000 });

// THE ORDER OF TWO WRITES, WHICH NOTHING ON SCREEN WOULD REVEAL.
//
// updateSession writes a session in two statements, because
// `require_scan_to_check_in` arrives with a migration the owner applies by hand
// and the console is routinely deployed against a database that does not have
// the column yet. Folded into one statement, an unknown column would fail the
// whole edit; that part is covered by the comments at the call site.
//
// What THIS file defends is the order. The policy write is the statement that
// can fail for reasons the other cannot, and it must therefore run FIRST, where
// a failure costs nothing. Run second — which is how it originally shipped — a
// hard error threw AFTER the name/date/location update had already committed,
// leaving a half-applied edit with no audit row and no revalidate, because both
// of those happen after it. There is no transaction available across two
// PostgREST statements, so ordering is the whole mechanism.
//
// A future refactor that "tidies" these back into the obvious order would
// reintroduce it in silence: every test would still pass, the toast would still
// say Session updated, and the damage would only appear as a session whose name
// changed while its audit log says nothing happened.

const calls: string[] = [];
let scanWriteError: { code?: string; message: string } | null = null;

/** Minimal PostgREST double: records which column set each update touched. */
function makeClient() {
  const builder = (table: string) => ({
    select: () => ({ eq: () => ({ single: async () => ({ data: { id: 's1' }, error: null }) }) }),
    update: (patch: Record<string, unknown>) => {
      const isScanWrite = 'require_scan_to_check_in' in patch;
      calls.push(isScanWrite ? 'scan-policy' : 'session-fields');
      return {
        eq: async () => ({ error: isScanWrite ? scanWriteError : null }),
      };
    },
    insert: async () => ({ error: null }),
    _table: table,
  });
  return { from: (table: string) => builder(table) };
}

// `server-only` is a build-time guard with no runtime implementation, and the
// action module reaches it transitively through session-reminders. Vitest runs
// in a node environment where it cannot resolve, so it is stubbed rather than
// the import chain being rearranged to suit a test.
vi.mock('server-only', () => ({}));

vi.mock('../supabase-server', () => ({ createAdminClient: () => makeClient() }));
vi.mock('../audit', () => ({
  logAdminAudit: async () => { calls.push('audit'); },
}));
// Path is relative to the MODULE UNDER TEST (lib/actions/sessions.ts), not to
// this file — mocking './_shared' here would silently register a mock for a
// module nothing imports, the real capability check would run, and every test
// would fail as an authorisation error wearing the costume of a logic bug.
vi.mock('../actions/_shared', () => ({ requireCapability: async () => ({ id: 'admin-1' }) }));
vi.mock('next/cache', () => ({ revalidatePath: () => { calls.push('revalidate'); } }));
vi.mock('../notify', () => ({ notifyPlayers: async () => undefined }));

const EDIT = {
  name: 'Wednesday drop-in',
  date: '2026-08-19',
  location: 'West Gym',
  track: 'all' as const,
  require_scan_to_check_in: true,
};

describe('updateSession write order', () => {
  beforeEach(() => {
    calls.length = 0;
    scanWriteError = null;
  });

  it('writes the scan policy BEFORE the rest of the session', async () => {
    const { updateSession } = await import('../actions/sessions');
    await updateSession('s1', EDIT, 'testing the order');

    expect(calls.indexOf('scan-policy')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('scan-policy')).toBeLessThan(calls.indexOf('session-fields'));
  });

  // The failure this ordering exists for. A hard error on the policy write must
  // abort before anything else is committed — no half-applied edit, and in
  // particular no audit row claiming an edit that only partly happened.
  it('leaves the session untouched when the policy write fails hard', async () => {
    scanWriteError = { code: '23514', message: 'violates check constraint' };
    const { updateSession } = await import('../actions/sessions');
    const res = await updateSession('s1', EDIT, 'testing the order');

    expect(res.ok).toBe(false);
    expect(calls).not.toContain('session-fields');
    expect(calls).not.toContain('audit');
  });

  // Pre-migration: the column genuinely is not there, the checkbox is a no-op,
  // and everything else must still save. This is the case the split exists for
  // and it must not be broken by the reordering.
  it('still saves everything else when the column does not exist yet', async () => {
    scanWriteError = { code: 'PGRST204', message: "Could not find the 'require_scan_to_check_in' column" };
    const { updateSession } = await import('../actions/sessions');
    const res = await updateSession('s1', EDIT, 'testing the order');

    expect(res.ok).toBe(true);
    expect(calls).toContain('session-fields');
    expect(calls).toContain('audit');
  });
});

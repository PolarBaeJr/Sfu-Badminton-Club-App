import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyScanWindow, loadEntryWindows, windowsFor } from '../tournament-windows';

// A client whose list reads answer per table, so the loader's degrade-or-throw
// split can be driven without a database.
function client(answers: Record<string, { data: unknown; error: { code?: string; message: string } | null }>) {
  const reads: Array<{ table: string; columns: string; ids: string[] }> = [];
  const c = {
    from: (table: string) => ({
      select: (columns: string) => ({
        in: (_col: string, ids: string[]) => {
          reads.push({ table, columns, ids });
          return Promise.resolve(answers[table] ?? { data: [], error: null });
        },
      }),
    }),
  };
  return { client: c as unknown as SupabaseClient, reads };
}

describe('loadEntryWindows', () => {
  it('reads only the window columns, once per table, deduplicated', async () => {
    const { client: c, reads } = client({
      tournament_events: { data: [{ id: 'e1', checkin_opens_at: '2026-10-01T00:00:00Z' }], error: null },
      tournaments: { data: [{ id: 't1', registration_closes_at: '2026-10-02T00:00:00Z' }], error: null },
    });
    const loaded = await loadEntryWindows(c, { eventIds: ['e1', 'e1'], tournamentIds: ['t1'] });
    expect(reads).toHaveLength(2);
    for (const r of reads) {
      expect(r.columns).toBe('id, registration_opens_at, registration_closes_at, checkin_opens_at, checkin_closes_at');
    }
    expect(reads[0]!.ids).toEqual(['e1']);
    expect(windowsFor(loaded, 'e1', 't1')).toEqual({
      registration: { opens_at: null, closes_at: '2026-10-02T00:00:00Z' },
      checkin: { opens_at: '2026-10-01T00:00:00Z', closes_at: null },
    });
  });

  it('reads nothing when asked about nothing', async () => {
    const { client: c, reads } = client({});
    await loadEntryWindows(c, {});
    expect(reads).toHaveLength(0);
  });

  it.each(['42703', 'PGRST204'])('is "no windows" on a database without 00276 (%s)', async (code) => {
    const { client: c } = client({
      tournament_events: { data: null, error: { code, message: 'column does not exist' } },
    });
    const loaded = await loadEntryWindows(c, { eventIds: ['e1'], tournamentIds: ['t1'] });
    expect(loaded.events.size).toBe(0);
    expect(loaded.tournaments.size).toBe(0);
  });

  it('throws on any other failure, because an unread window is not an open one', async () => {
    const { client: c } = client({
      tournaments: { data: null, error: { code: '57014', message: 'canceling statement' } },
    });
    await expect(loadEntryWindows(c, { tournamentIds: ['t1'] })).rejects.toThrow(/canceling statement/);
  });
});

describe('classifyScanWindow', () => {
  const now = new Date('2026-10-01T12:00:00Z');

  it('claims inside the window and with no window at all', () => {
    expect(classifyScanWindow({ opens_at: null, closes_at: null }, now)).toBe('claim');
    expect(classifyScanWindow({ opens_at: '2026-10-01T12:00:00Z', closes_at: '2026-10-01T13:00:00Z' }, now)).toBe('claim');
  });

  it('is pending before the window opens', () => {
    expect(classifyScanWindow({ opens_at: '2026-10-01T12:00:01Z', closes_at: null }, now)).toBe('pending');
  });

  it('is refused once the window has closed', () => {
    expect(classifyScanWindow({ opens_at: null, closes_at: '2026-10-01T12:00:00Z' }, now)).toBe('refused');
  });
});

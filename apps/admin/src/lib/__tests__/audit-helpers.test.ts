import { describe, it, expect, beforeEach, vi } from 'vitest';

// A REFUSED AUDIT INSERT MUST NOT LOOK LIKE A SUCCESSFUL ONE.
//
// Both helpers promise the same contract and only one of them kept it. logAudit
// awaited the insert and dropped the `error` it resolved with — and supabase-js
// RESOLVES rather than rejects on a PostgREST failure, so a revoked column grant,
// a constraint violation or a dropped socket all looked exactly like a row going
// in. The tournament audit trail could lose entries with nothing anywhere to say
// so, which is the one outcome neither of the two sensible policies wanted:
// either fail the action or report the loss, but never be silent about it.
//
// The other half of the contract is just as load-bearing and is asserted here
// too: NEITHER helper may throw. Every caller has already committed the write
// the row describes, so a rejection would turn a lost audit entry into a failed
// tournament result or a failed fee.

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  inserted: [] as { table: string; row: Row }[],
  /** Set to make the insert resolve with an error, the way PostgREST does. */
  failWith: null as string | null,
  sentry: [] as { message: string; extra: Row }[],
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: (err: unknown, ctx?: { extra?: Row }) => {
    state.sentry.push({ message: String((err as Error)?.message ?? err), extra: ctx?.extra ?? {} });
  },
}));

import { logAudit, logAdminAudit } from '../audit';

const client = {
  from: (table: string) => ({
    insert: async (row: Row) => {
      if (state.failWith) return { error: { message: state.failWith } };
      state.inserted.push({ table, row });
      return { error: null };
    },
  }),
} as never;

beforeEach(() => {
  state.inserted = [];
  state.failWith = null;
  state.sentry = [];
});

describe('logAudit (tournament trail)', () => {
  const entry = {
    tournament_id: 'tourn-1',
    match_id: 'match-1',
    action: 'result_entered',
    performed_by: 'exec-1',
    details: { score: '21-19' },
  };

  it('writes the row, filling the unnamed scopes with null', async () => {
    await logAudit(client, entry);

    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]!.table).toBe('tournament_audit_log');
    // event_id was not supplied; an explicit null is what the column wants, not
    // `undefined`, which PostgREST would omit from the payload entirely.
    expect(state.inserted[0]!.row.event_id).toBeNull();
    expect(state.sentry).toEqual([]);
  });

  // THE DEFECT. Before this the function discarded `error` and returned as though
  // the row had landed.
  it('reports a refused insert to Sentry instead of swallowing it', async () => {
    state.failWith = 'permission denied for table tournament_audit_log';

    await logAudit(client, entry);

    expect(state.sentry).toHaveLength(1);
    expect(state.sentry[0]!.message).toMatch(/tournament audit log write failed/i);
    expect(state.sentry[0]!.message).toMatch(/permission denied/);
    // Enough scope to find the act that went unrecorded, not just that one did.
    expect(state.sentry[0]!.extra.action).toBe('result_entered');
    expect(state.sentry[0]!.extra.tournamentId).toBe('tourn-1');
    expect(state.sentry[0]!.extra.matchId).toBe('match-1');
  });

  it('does not throw, because the write it describes is already committed', async () => {
    state.failWith = 'connection reset';
    await expect(logAudit(client, entry)).resolves.toBeUndefined();
  });
});

describe('logAdminAudit (general trail)', () => {
  const entry = {
    actor_id: 'exec-1',
    action_type: 'player_approved',
    target_type: 'player',
    target_id: 'player-1',
  };

  it('reports a refused insert and still does not throw', async () => {
    state.failWith = 'null value in column "action_type"';

    await expect(logAdminAudit(client, entry, { playerId: 'player-1' })).resolves.toBeUndefined();

    expect(state.sentry).toHaveLength(1);
    expect(state.sentry[0]!.message).toMatch(/audit log write failed/i);
    // The caller's own context is merged in, so the report names the subject as
    // well as the action.
    expect(state.sentry[0]!.extra.playerId).toBe('player-1');
    expect(state.sentry[0]!.extra.action).toBe('player_approved');
  });

  it('is silent when the row goes in', async () => {
    await logAdminAudit(client, entry);
    expect(state.inserted).toHaveLength(1);
    expect(state.sentry).toEqual([]);
  });
});

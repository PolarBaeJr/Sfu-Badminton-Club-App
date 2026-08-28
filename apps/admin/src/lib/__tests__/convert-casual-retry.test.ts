import { describe, it, expect, beforeEach, vi } from 'vitest';

// RETRYING THE SAME RESOLUTION MUST NOT UNDO IT.
//
// dispute-claim-fence.test.ts covers the OTHER half of F-002: that a retry
// arriving as a DIFFERENT resolution is refused before any match is touched.
// This file covers the half that fence deliberately lets through. 00192 permits
// — and has to permit — a retry of the same resolution, because after a failed
// close that is the only resolution the dispute will still accept. Its stated
// justification was that "both mutations are idempotent for their own type".
//
// convertMatchToCasual was not. It branched on the match's live result_status,
// so the very state its own first attempt produced ('confirmed', via
// apply_match_result) sent the retry down the reverse_match_result arm and left
// the match 'voided' with the rating reversed back out, while the dispute
// closed as converted_to_casual. Nothing in the suite caught it because the
// existing test never runs the same resolution twice.
//
// So these assert on the RPCs and the column writes the retry performs, not on
// whether it threw. A version that voided the match and returned ok would pass
// any throw-only test with the defect fully intact.

type Row = { result_status: string; event_type: string; rated_flag: boolean };

const store = vi.hoisted(() => ({
  row: {} as Row,
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  updates: [] as Record<string, unknown>[],
}));

vi.mock('../supabase-server', () => ({
  createAdminClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      store.rpcs.push({ fn, args });
      // Mirror what the real functions do to the row, so a second call in the
      // same test observes the first call's effect exactly as Postgres would.
      if (fn === 'reverse_match_result') store.row.result_status = 'voided';
      if (fn === 'apply_match_result') store.row.result_status = 'confirmed';
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.single = () => Promise.resolve({ data: { ...store.row }, error: null });
      chain.update = (patch: Record<string, unknown>) => {
        if (table === 'matches') {
          store.updates.push(patch);
          Object.assign(store.row, patch);
        }
        return chain;
      };
      chain.insert = () => Promise.resolve({ data: null, error: null });
      chain.upsert = () => Promise.resolve({ data: null, error: null });
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
      return chain;
    },
  }),
}));

vi.mock('./_shared', () => ({}));
vi.mock('../actions/_shared', () => ({
  requireCapability: () => Promise.resolve({ id: 'admin-1' }),
}));
vi.mock('../audit', () => ({ logAdminAudit: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));

const { convertMatchToCasual } = await import('../actions/matches');

const M_ID = '11111111-1111-1111-1111-111111111111';
const rpcNames = () => store.rpcs.map((r) => r.fn);

beforeEach(() => {
  store.rpcs.length = 0;
  store.updates.length = 0;
});

describe('convert to casual, retried as the same resolution', () => {
  it('leaves a never-confirmed match confirmed and casual, not voided', async () => {
    // The exact sequence codex supplied. Step 1 is the ordinary first attempt.
    store.row = { result_status: 'disputed', event_type: 'league', rated_flag: true };

    const first = await convertMatchToCasual(M_ID, 'played for fun');
    expect(first.ok).toBe(true);
    expect(rpcNames()).toEqual(['apply_match_result']);
    expect(store.row).toMatchObject({ result_status: 'confirmed', event_type: 'casual', rated_flag: false });

    // Step 2/3: the close failed, the admin retries as the same resolution.
    const second = await convertMatchToCasual(M_ID, 'played for fun');
    expect(second.ok).toBe(true);

    // THE REGRESSION. The retry must add NOTHING to this list; before the fix it
    // appended 'reverse_match_result' and the row came back 'voided'.
    expect(rpcNames()).toEqual(['apply_match_result']);
    expect(store.row.result_status).toBe('confirmed');
    expect(store.row.event_type).toBe('casual');
    expect(store.row.rated_flag).toBe(false);
  });

  it('does not reverse a rated match twice', async () => {
    store.row = { result_status: 'confirmed', event_type: 'league', rated_flag: true };

    await convertMatchToCasual(M_ID, 'mis-scheduled');
    expect(rpcNames()).toEqual(['reverse_match_result']);
    expect(store.row).toMatchObject({ result_status: 'voided', event_type: 'casual', rated_flag: false });

    await convertMatchToCasual(M_ID, 'mis-scheduled');
    // A second reversal would credit the rating change back a second time.
    expect(rpcNames()).toEqual(['reverse_match_result']);
    expect(store.row.result_status).toBe('voided');
  });

  it('finishes a conversion that died between the reversal and the flags', async () => {
    // reverse_match_result committed, the flag write did not. The retry must
    // write the flags WITHOUT confirming — apply_match_result here would move a
    // voided match back to confirmed and count head-to-head a second time.
    store.row = { result_status: 'voided', event_type: 'league', rated_flag: true };

    await convertMatchToCasual(M_ID, 'mis-scheduled');

    expect(rpcNames()).toEqual([]);
    expect(store.row).toMatchObject({ result_status: 'voided', event_type: 'casual', rated_flag: false });
  });

  it('still confirms a match that was already casual before the dispute', async () => {
    // The arm the idempotency check must NOT swallow: casual and unrated
    // already, but never settled, so the conversion still has work to do.
    store.row = { result_status: 'disputed', event_type: 'casual', rated_flag: false };

    await convertMatchToCasual(M_ID, 'disputed casual game');

    expect(rpcNames()).toEqual(['apply_match_result']);
    expect(store.row.result_status).toBe('confirmed');
  });
});

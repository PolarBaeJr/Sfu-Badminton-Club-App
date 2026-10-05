import { describe, it, expect, vi, beforeEach } from 'vitest';

// completeOnboardingCore is the one body web onboarding and Discord /signup
// both run. These pin the order (the acceptances before the flag that approves
// the member), the newly required answers, and that the two doors differ only
// in the user agent they record.

type Call = { table: string; op: string; payload?: unknown };

let calls: Call[] = [];
let player: Record<string, unknown> | null = null;

function memberClient() {
  // Remembered, so the second insertAcceptances finds nothing missing, as it
  // would against the real table.
  const accepted: unknown[] = [];
  const from = (table: string) => {
    const chain = (op: string, payload?: unknown) => {
      calls.push({ table, op, payload });
      if (table === 'waiver_acceptances' && op === 'insert') accepted.push(...(payload as unknown[]));
      const result = () => {
        if (table === 'legal_documents') {
          return {
            data: [
              { document: 'waiver', version: 'w1', reacceptance_required_since: null },
              { document: 'terms_of_use', version: 't1', reacceptance_required_since: null },
            ],
            error: null,
          };
        }
        if (table === 'waiver_acceptances' && op === 'select') {
          return {
            data: accepted.map((row) => ({ ...(row as object), accepted_at: new Date().toISOString() })),
            error: null,
          };
        }
        return { data: null, error: null };
      };
      const builder: Record<string, unknown> = {
        eq: () => builder,
        maybeSingle: async () => ({ data: { waiver_reset_at: null }, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return builder;
    };
    return {
      select: () => chain('select'),
      insert: (payload: unknown) => chain('insert', payload),
      update: (payload: unknown) => chain('update', payload),
    };
  };
  return {
    from,
    rpc: async (name: string, params: unknown) => {
      calls.push({ table: name, op: 'rpc', payload: params });
      return { data: null, error: null };
    },
  };
}

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('../first-signin', () => ({ ensurePlayerRowForUser: async () => {} }));
vi.mock('../member-audit', () => ({ logMemberAudit: async () => {} }));
vi.mock('../supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      update: () => ({ eq: async () => ({ error: null }) }),
      select: () => ({ is: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
    }),
    rpc: async () => ({ data: true, error: null }),
  }),
}));

const { completeOnboardingCore } = await import('../onboarding-core');

const INPUT = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  event_category: 'womens' as const,
  waiver_accepted: true,
  code_of_conduct_accepted: true,
  terms_accepted: true,
  age_attestation: true,
};

async function run(userAgent: string | null, input: Record<string, unknown> = INPUT) {
  return completeOnboardingCore(
    memberClient() as never,
    { id: 'user-1', email: 'ada@example.com' },
    input as never,
    { userAgent, loadPlayer: async () => player as never },
  );
}

beforeEach(() => {
  calls = [];
  player = { id: 'player-1', first_name: '' };
});

describe('completeOnboardingCore', () => {
  it('records the acceptances and the events answer before the flag that approves the member', async () => {
    await run('Mozilla/5.0');
    const acceptance = calls.findIndex((call) => call.table === 'waiver_acceptances' && call.op === 'insert');
    const category = calls.findIndex(
      (call) => call.table === 'players' && call.op === 'update' && (call.payload as Record<string, unknown>).competition_category === 'womens',
    );
    const flag = calls.findIndex(
      (call) => call.table === 'players' && call.op === 'update' && (call.payload as Record<string, unknown>).onboarding_completed === true,
    );
    expect(acceptance).toBeGreaterThanOrEqual(0);
    expect(category).toBeGreaterThan(acceptance);
    expect(flag).toBeGreaterThan(category);
    expect(calls[flag]!.payload).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace' });
  });

  it('writes no category for Open events only', async () => {
    await run(null, { ...INPUT, event_category: 'open' });
    expect(
      calls.some((call) => call.op === 'update' && 'competition_category' in (call.payload as Record<string, unknown>)),
    ).toBe(false);
  });

  it('refuses a missing last name', async () => {
    await expect(run(null, { ...INPUT, last_name: '' })).rejects.toThrow('Last name is required');
    expect(calls).toEqual([]);
  });

  it('refuses a missing events answer', async () => {
    const { event_category: _omitted, ...withoutAnswer } = INPUT;
    await expect(run(null, withoutAnswer)).rejects.toThrow('Choose which events you play in tournaments');
    expect(calls).toEqual([]);
  });

  it('the web and Discord make the same calls, differing only in the user agent', async () => {
    await run('Mozilla/5.0');
    const web = calls;
    calls = [];
    await run('Discord /signup');
    const discord = calls;

    const userAgents = (log: Call[]) =>
      log
        .filter((call) => call.table === 'waiver_acceptances' && call.op === 'insert')
        .flatMap((call) => (call.payload as { user_agent: string }[]).map((row) => row.user_agent));
    expect(userAgents(web)).toEqual(['Mozilla/5.0', 'Mozilla/5.0']);
    expect(userAgents(discord)).toEqual(['Discord /signup', 'Discord /signup']);

    const withoutAgent = (log: Call[]) =>
      log.map((call) =>
        call.table === 'waiver_acceptances' && call.op === 'insert'
          ? { ...call, payload: (call.payload as Record<string, unknown>[]).map(({ user_agent: _agent, ...row }) => row) }
          : call,
      );
    expect(withoutAgent(discord)).toEqual(withoutAgent(web));
  });
});

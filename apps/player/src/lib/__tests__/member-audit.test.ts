import { describe, it, expect, beforeEach, vi } from 'vitest';

// SELF-SERVICE WRITES OF PRIVILEGED STATE NOW LEAVE A TRAIL.
//
// Every admin-side write of these columns is audited. cancelAccountDeletion files
// 'account_deletion_cancelled' with the previous value; updatePlayer carries the
// whole previous row whenever a rating moves, and singles_elo/doubles_elo are on
// PLAYER_FIELD_PRIVILEGED precisely so no exec can move one by hand. The member's
// own equivalents wrote the same columns through the service-role client and left
// nothing at all, so the console's answer to "why is this account deactivated" or
// "where did this rating come from" depended on WHO had done it — which is not
// what an audit log is for.
//
// The asymmetry, not the absence, was the finding, and the fix is differential.
// reactivateLapsedMember has always written a 'self_reactivated' row and is the
// shape all of these follow: actor_id is the member, the reason is a fixed
// sentence (there is no dialog to type one into, so requireReason has no analogue
// here), and a failed insert is reported rather than thrown. Profile edits stay
// unaudited, and so does create_player_with_rating — see the note at its call
// site for why creating a row destroys nothing and records nothing a reader needs.

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  player: {} as Row,
  audit: [] as Row[],
  /** What apply_skill_tier_seed answers: did it actually write a rating? */
  seeded: true as boolean | null,
  rpcCalls: [] as { name: string; args: Row }[],
  events: [] as string[],
  auditFails: false,
  sentry: [] as string[],
}));

const serviceClient = vi.hoisted(() => () => ({
  from: (table: string) => {
    const self: Record<string, unknown> = {
      select: () => self,
      eq: () => self,
      insert: (row: Row) => {
        if (table === 'audit_logs') {
          if (state.auditFails) return Promise.resolve({ error: { message: 'permission denied' } });
          state.audit.push(row);
        }
        return Promise.resolve({ error: null });
      },
      update: (values: Row) => {
        if (table === 'players') Object.assign(state.player, values);
        return self;
      },
      maybeSingle: async () => ({ data: null, error: null }),
      limit: () => self,
      is: () => self,
      then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
    };
    return self;
  },
  rpc: async (name: string, args: Row) => {
    state.rpcCalls.push({ name, args });
    if (name === 'apply_skill_tier_seed') return { data: state.seeded, error: null };
    return { data: null, error: null };
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({ headers: async () => new Map() }));
vi.mock('@sentry/nextjs', () => ({
  captureException: (err: unknown) => { state.sentry.push(String((err as Error)?.message ?? err)); },
}));
vi.mock('../first-signin', () => ({ ensurePlayerRowForUser: async () => {} }));
vi.mock('../rating-tiers', () => ({ getSkillTierOptions: async () => [] }));

vi.mock('../supabase-server', () => ({
  createServiceRoleClient: serviceClient,
  // Onboarding's own writes go through the caller's session client. The only
  // table it reads here is legal_documents, and an empty list short-circuits
  // insertAcceptances — this suite is about the audit rows, not the waiver gate.
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'ada@sfu.ca' } } }) },
    from: (table: string) => {
      const self: Record<string, unknown> = {
        select: () => self,
        eq: () => self,
        insert: () => Promise.resolve({ error: null }),
        update: (values: Row) => {
          if (table === 'players') Object.assign(state.player, values);
          return self;
        },
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
          resolve({ data: [], error: null }),
      };
      return self;
    },
  }),
  // A DETACHED COPY, because the real one returns PostgREST JSON. Handing out the
  // store object would let the UPDATE mutate the snapshot the action is holding
  // for old_value, which is exactly the class of bug these assertions are for.
  getCurrentPlayer: async () => ({ ...state.player }),
}));

// '../actions/_shared' and not './_shared': vi.mock resolves the specifier
// against THIS file, and the module under test lives one directory over.
vi.mock('../actions/_shared', async () => ({
  requirePlayer: async () => ({ ...state.player }),
  trackServerEvent: (_id: string, event: string) => { state.events.push(event); },
  runAction: async <T>(fn: () => Promise<T>) => {
    try {
      return { ok: true as const, data: await fn() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'failed' };
    }
  },
}));

import { deleteMyAccount, restoreMyAccount, completeOnboarding } from '../actions/profile';

const PLAYER = '33333333-3333-4333-8333-333333333333';

const rowsOfType = (type: string) => state.audit.filter((r) => r.action_type === type);

beforeEach(() => {
  state.player = {
    id: PLAYER, first_name: 'Ada', active_flag: true,
    deletion_requested_at: null, onboarding_completed: false,
  };
  state.audit = [];
  state.rpcCalls = [];
  state.events = [];
  state.seeded = true;
  state.auditFails = false;
  state.sentry = [];
});

describe('deleteMyAccount', () => {
  it('files an audit row naming the member as the actor', async () => {
    const res = await deleteMyAccount('DELETE');
    expect(res.ok).toBe(true);

    const [row] = rowsOfType('self_deletion_requested');
    expect(row).toBeTruthy();
    // Actor AND target: the member did this to themselves, which is the whole
    // distinction from the console's version of the same write.
    expect(row!.actor_id).toBe(PLAYER);
    expect(row!.target_id).toBe(PLAYER);
    expect(row!.target_type).toBe('player');
    // The stamp that was actually written, not a second now() — the audit row and
    // the column have to agree.
    expect((row!.new_value as Row).deletion_requested_at).toBe(state.player.deletion_requested_at);
    expect((row!.new_value as Row).active_flag).toBe(false);
    expect((row!.old_value as Row).deletion_requested_at).toBeNull();
    expect(row!.reason).toMatch(/requested deletion/i);
  });

  // PostHog is not the audit trail: a separate system, not joined to the row and
  // not readable from /audit. Both fire, and the test says so out loud because
  // "we already track this" was the reason there was no audit row.
  it('still sends the analytics event as well', async () => {
    await deleteMyAccount('DELETE');
    expect(state.events).toContain('account_deletion_requested');
    expect(rowsOfType('self_deletion_requested')).toHaveLength(1);
  });

  it('writes nothing when the confirmation is wrong', async () => {
    const res = await deleteMyAccount('delete');
    expect(res.ok).toBe(false);
    expect(state.audit).toEqual([]);
    expect(state.player.deletion_requested_at).toBeNull();
  });

  // The member is already deleted by the time the row is attempted. Losing the
  // entry must not fail their action, and must not vanish silently either.
  it('reports a failed audit insert without failing the deletion', async () => {
    state.auditFails = true;

    const res = await deleteMyAccount('DELETE');

    expect(res.ok).toBe(true);
    expect(state.player.active_flag).toBe(false);
    expect(state.sentry.some((m) => /audit log write failed/i.test(m))).toBe(true);
  });
});

describe('restoreMyAccount', () => {
  it('files its own action type, distinct from the console’s', async () => {
    state.player.deletion_requested_at = '2026-08-01T00:00:00.000Z';

    const res = await restoreMyAccount();
    expect(res.ok).toBe(true);

    const [row] = rowsOfType('self_deletion_cancelled');
    expect(row).toBeTruthy();
    // NOT 'account_deletion_cancelled'. The two writes are identical and the
    // actors are not, and a reader who cannot tell "an admin rescued this" from
    // "the member changed their mind" has been told less than the log knows.
    expect(rowsOfType('account_deletion_cancelled')).toHaveLength(0);
    expect((row!.old_value as Row).deletion_requested_at).toBe('2026-08-01T00:00:00.000Z');
    expect((row!.new_value as Row).active_flag).toBe(true);
  });

  it('writes nothing when no deletion is scheduled', async () => {
    const res = await restoreMyAccount();
    expect(res.ok).toBe(false);
    expect(state.audit).toEqual([]);
  });
});

describe('the onboarding rating seed', () => {
  const onboarding = {
    first_name: 'Ada',
    waiver_accepted: true,
    code_of_conduct_accepted: true,
    terms_accepted: true,
    age_attestation: true,
    skill_tier: 'advanced' as const,
  };

  // A rating rewrite by any other name. The admin who may do this writes an audit
  // row with the previous rating and a typed reason; the member's route wrote
  // nothing, so a rating that arrived here was indistinguishable from one that had
  // always been there.
  it('audits the seed when the function says it wrote a rating', async () => {
    state.seeded = true;

    await completeOnboarding(onboarding);

    expect(state.rpcCalls.map((c) => c.name)).toContain('apply_skill_tier_seed');
    const [row] = rowsOfType('self_rating_seeded');
    expect(row).toBeTruthy();
    expect(row!.actor_id).toBe(PLAYER);
    // The TIER, not a rating. The number is resolved and clamped in SQL out of
    // platform_settings, and duplicating that arithmetic here is the
    // two-implementations drift 00127 was written to avoid.
    expect((row!.new_value as Row).skill_tier).toBe('advanced');
  });

  // apply_skill_tier_seed returns FALSE whenever the rating has ever moved or was
  // set deliberately by an exec. Auditing unconditionally would file rows claiming
  // changes the guard refused, which is worse than filing none.
  it('files nothing when the function declined to seed', async () => {
    state.seeded = false;

    await completeOnboarding(onboarding);

    expect(state.rpcCalls.map((c) => c.name)).toContain('apply_skill_tier_seed');
    expect(rowsOfType('self_rating_seeded')).toHaveLength(0);
  });

  it('files nothing when no tier was claimed', async () => {
    await completeOnboarding({ ...onboarding, skill_tier: undefined });

    expect(state.rpcCalls.map((c) => c.name)).not.toContain('apply_skill_tier_seed');
    expect(rowsOfType('self_rating_seeded')).toHaveLength(0);
  });
});

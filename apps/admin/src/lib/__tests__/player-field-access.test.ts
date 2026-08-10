import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Capability } from '../permissions';

// This suite pins the security boundary the club owner drew: "leave elevation
// of privilege to exec/admin to admins". Execs manage the roster; only admins
// grant privilege or touch money.
//
// It exercises the REAL server action rather than the guard helper, because the
// guard only matters if updatePlayer actually calls it — and because the
// database cannot be the backstop here: guard_player_privileged_columns returns
// early when auth.uid() IS NULL, and these actions all run on the service-role
// client.

type Actor = { id: string; role: string; is_exec?: boolean; is_trainer?: boolean };

const state = vi.hoisted(() => ({
  // Who is calling. The actor row carries the same markers the real one does —
  // the guard resolves a LEVEL from them (admin > exec > trainer) rather than
  // reading role alone, so a row missing is_exec correctly fails closed.
  actor: { id: 'actor-1', role: 'player', is_exec: true } as Actor,
  // Every table write the action performed, so a rejected request can be shown
  // to have written nothing at all.
  updates: [] as { table: string; values: Record<string, unknown> }[],
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('../audit', () => ({ logAdminAudit: async () => {} }));

vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));

// The REAL gate: permits() against the real baselines, with the same denial
// wording the live one produces. A varsity trainer is turned away HERE, before
// any payload is inspected — the field guard is the second line, not the first.
vi.mock('../actions/_shared', async () => {
  const {
    accessLevelFor, permits, UNRESTRICTED, EXEC_BASELINE, TRAINER_BASELINE,
  } = await import('../permissions');
  return {
    requireCapability: async (capability: Capability) => {
      if (!permits(accessLevelFor(state.actor), UNRESTRICTED, capability)) {
        throw new Error(
          TRAINER_BASELINE.includes(capability)
            ? 'Admin console access required'
            : EXEC_BASELINE.includes(capability)
              ? 'Admin or exec access required'
              : 'Admin access required',
        );
      }
      return state.actor;
    },
  };
});

vi.mock('../supabase-server', () => {
  const builder = (table: string) => {
    const self: Record<string, unknown> = {
      select: () => self,
      eq: () => self,
      update: (values: Record<string, unknown>) => {
        state.updates.push({ table, values });
        return self;
      },
      single: async () => ({ data: { id: 'player-9', status: 'recreational' } }),
      maybeSingle: async () => ({ data: null }),
      then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
    };
    return self;
  };
  return {
    createAdminClient: () => ({ from: (table: string) => builder(table) }),
  };
});

// Imported after the mocks are registered.
import { updatePlayer } from '../actions/players';

beforeEach(() => {
  state.actor = { id: 'actor-1', role: 'player', is_exec: true };
  state.updates = [];
});

const asExec = () => { state.actor = { id: 'exec-1', role: 'player', is_exec: true }; };
const asAdmin = () => { state.actor = { id: 'admin-1', role: 'admin' }; };
// A PURE varsity trainer: no exec marker, not an admin.
const asTrainer = () => { state.actor = { id: 'trainer-1', role: 'player', is_trainer: true }; };
// Someone who trains the varsity squad AND sits on the exec. The club owner's
// composition rule: they get exec powers, because the restriction follows the
// level a person resolves to, not the flag in isolation.
const asExecTrainer = () => {
  state.actor = { id: 'exec-trainer-1', role: 'player', is_exec: true, is_trainer: true };
};

describe('updatePlayer field-level access', () => {
  it('lets an exec change status (ban-by-status is roster management)', async () => {
    asExec();
    const res = await updatePlayer('player-9', { status: 'suspended', reason: 'Repeated no-shows' });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { status: 'suspended' } });
  });

  // Reversed after the club owner's ruling: execs record results, the engine
  // decides ratings. A hand-set number bypasses every K factor, bound and margin
  // rule, on the one value the whole ladder exists for.
  it('rejects an exec who supplies singles_elo', async () => {
    asExec();
    const res = await updatePlayer('player-9', { singles_elo: 1200, reason: 'Seeding correction' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('singles_elo');
    expect(state.updates).toEqual([]);
  });

  it('rejects an exec who supplies doubles_elo', async () => {
    asExec();
    const res = await updatePlayer('player-9', { doubles_elo: 1200, reason: 'Seeding correction' });
    expect(res.ok).toBe(false);
    expect(state.updates).toEqual([]);
  });

  it('still lets an admin set a rating', async () => {
    asAdmin();
    const res = await updatePlayer('player-9', { singles_elo: 1200, reason: 'Seeding correction' });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'ratings', values: { singles_elo: 1200 } });
  });

  it('rejects an exec who supplies role — this is the escalation path', async () => {
    asExec();
    const res = await updatePlayer('player-9', { role: 'admin', reason: 'Promoting myself' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Admin access required');
    // Rejected outright, not silently stripped: nothing was written.
    expect(state.updates).toEqual([]);
  });

  it('rejects an exec who supplies is_exec', async () => {
    asExec();
    const res = await updatePlayer('player-9', { is_exec: true, reason: 'Adding a friend to the exec team' });
    expect(res.ok).toBe(false);
    expect(state.updates).toEqual([]);
  });

  it('rejects an exec who supplies fee_exempt (money is admin-only)', async () => {
    asExec();
    const res = await updatePlayer('player-9', { fee_exempt: true, reason: 'Waiving a fee' });
    expect(res.ok).toBe(false);
    expect(state.updates).toEqual([]);
  });

  it('rejects the whole request even when the admin-only field rides along with an allowed one', async () => {
    asExec();
    const res = await updatePlayer('player-9', { status: 'competitive', is_exec: true, reason: 'Mixed payload' });
    expect(res.ok).toBe(false);
    // The permitted half must not land either — a partial save would look like
    // a success that half-worked.
    expect(state.updates).toEqual([]);
  });

  it('accepts the shape the exec UI actually sends: admin-only keys present but undefined', async () => {
    // edit-form.tsx builds one object and sets every admin-only field to
    // `isAdmin && changed ? value : undefined`, so the KEYS are there for an
    // exec too. Presence means "!== undefined", not "key exists" — if that ever
    // drifts, every exec save breaks and this is the test that says so.
    asExec();
    const res = await updatePlayer('player-9', {
      status: 'competitive',
      role: undefined,
      is_exec: undefined,
      exec_title: undefined,
      exec_photo_url: undefined,
      fee_exempt: undefined,
      reason: 'Ordinary status change from the edit form',
    });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { status: 'competitive' } });
  });

  it('lets an admin change role', async () => {
    asAdmin();
    const res = await updatePlayer('player-9', { role: 'admin', reason: 'Promotion' });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { role: 'admin' } });
  });

  it('lets an admin change is_exec and fee_exempt', async () => {
    asAdmin();
    const res = await updatePlayer('player-9', { is_exec: true, fee_exempt: true, reason: 'New exec' });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { is_exec: true, fee_exempt: true } });
  });

  it('rejects an exec who supplies a blank exec_title', async () => {
    // The trap: blankAsUndefined turns '' into undefined during PARSING, but
    // the write path reads the RAW payload, so '' still reaches the column. A
    // guard that only looked at the parsed value waved this through and let an
    // exec blank a colleague's entry on the public /exec page.
    asExec();
    const res = await updatePlayer('player-9', {
      status: 'competitive',
      exec_title: '',
      reason: 'Hand-rolled payload aimed straight at the server action',
    } as never);
    expect(res.ok).toBe(false);
    expect(state.updates).toEqual([]);
  });
});

describe('createPlayer field-level access', () => {
  it('lets an exec add a plain member but not an exec', async () => {
    const { createPlayer } = await import('../actions/players');
    asExec();
    const denied = await createPlayer({
      first_name: 'Ada', email: 'ada@sfu.ca', status: 'recreational', role: 'player', is_exec: true,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain('Admin access required');
  });

  it('will not let an exec mint a trainer account either', async () => {
    // Same escalation from the other side as is_exec: a trainer account is
    // console access, and creating one works around "you cannot promote
    // yourself" just as neatly.
    const { createPlayer } = await import('../actions/players');
    asExec();
    const denied = await createPlayer({
      first_name: 'Ada', email: 'ada2@sfu.ca', status: 'recreational', role: 'player', is_trainer: true,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain('Admin access required');
  });
});

// ---------------------------------------------------------------------------
// Varsity trainer
// ---------------------------------------------------------------------------
// The club owner's rule: "a varsity trainer only has players and varsity notes."
// Players READ-ONLY — they are there to find the person they are writing about.
// Their writable set on a player record is EMPTY.
describe('varsity trainer cannot touch player records', () => {
  it('is turned away by updatePlayer before any field is even looked at', async () => {
    asTrainer();
    const res = await updatePlayer('player-9', { status: 'competitive', reason: 'Trying it on' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('exec');
    expect(state.updates).toEqual([]);
  });

  it('cannot change status, membership, ratings, or grant themselves anything', async () => {
    // Every one of these is a separate refusal, not one blanket "no writes":
    // if updatePlayer is ever moved to a lower gate by mistake, each of these
    // must still fail on its own.
    const payloads: Record<string, unknown>[] = [
      { status: 'competitive', reason: 'r' },
      { membership_type: 'internal', reason: 'r' },
      { singles_elo: 1200, reason: 'r' },
      { doubles_elo: 1200, reason: 'r' },
      { role: 'admin', reason: 'r' },
      { is_exec: true, reason: 'r' },
      { is_trainer: true, reason: 'r' },
      { fee_exempt: true, reason: 'r' },
    ];
    for (const payload of payloads) {
      asTrainer();
      state.updates = [];
      const res = await updatePlayer('player-9', payload as never);
      expect(res.ok, `trainer was allowed to send ${JSON.stringify(payload)}`).toBe(false);
      expect(state.updates).toEqual([]);
    }
  });

  it('is rejected by the field guard directly, with an EMPTY writable set', async () => {
    // Belt and braces behind the gate above. Asserted against the guard itself
    // so the boundary holds even if a future action calls it with a trainer.
    const { assertPlayerFieldAccess, TRAINER_WRITABLE_PLAYER_FIELDS } =
      await import('../player-field-access');
    expect(TRAINER_WRITABLE_PLAYER_FIELDS).toEqual([]);

    const trainer = { role: 'player', is_trainer: true };
    // Not just the admin-only list — ANY field, including ones an exec may write.
    for (const field of ['status', 'membership_type', 'first_name', 'phone', 'singles_elo', 'is_trainer']) {
      expect(() => assertPlayerFieldAccess(trainer, [{ [field]: 'x' }]))
        .toThrowError(/Varsity trainers cannot change player records/);
    }
    // An empty payload is not a write, so it is not an error.
    expect(() => assertPlayerFieldAccess(trainer, [{}])).not.toThrow();
    // Keys present but undefined are not supplied — same rule the exec path uses.
    expect(() => assertPlayerFieldAccess(trainer, [{ status: undefined }])).not.toThrow();
  });

  it('fails CLOSED for an actor whose level cannot be resolved', async () => {
    const { assertPlayerFieldAccess } = await import('../player-field-access');
    // No markers at all — treated as the most restricted caller, never waved
    // through as an exec.
    expect(() => assertPlayerFieldAccess({ role: 'player' }, [{ status: 'competitive' }])).toThrow();
    expect(() => assertPlayerFieldAccess(null, [{ status: 'competitive' }])).toThrow();
    expect(() => assertPlayerFieldAccess(undefined, [{ status: 'competitive' }])).toThrow();
  });
});

describe('trainer composes with exec', () => {
  it('an exec who is also a trainer keeps every exec power', async () => {
    asExecTrainer();
    const res = await updatePlayer('player-9', { status: 'competitive', reason: 'Ordinary exec work' });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { status: 'competitive' } });
  });

  it('...and is still not an admin', async () => {
    asExecTrainer();
    const res = await updatePlayer('player-9', { is_exec: true, reason: 'Promoting a friend' });
    expect(res.ok).toBe(false);
    expect(state.updates).toEqual([]);
  });

  it('an admin who is also a trainer keeps every admin power', async () => {
    state.actor = { id: 'admin-trainer-1', role: 'admin', is_trainer: true };
    const res = await updatePlayer('player-9', { is_trainer: true, reason: 'Appointing a trainer' });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { is_trainer: true } });
  });
});

describe('is_trainer is admin-only, exactly like is_exec', () => {
  it('rejects an exec who supplies is_trainer', async () => {
    asExec();
    const res = await updatePlayer('player-9', { is_trainer: true, reason: 'Appointing a trainer' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('is_trainer');
    expect(state.updates).toEqual([]);
  });

  it('lets an admin grant and revoke it', async () => {
    asAdmin();
    const granted = await updatePlayer('player-9', { is_trainer: true, reason: 'New varsity trainer' });
    expect(granted.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { is_trainer: true } });

    state.updates = [];
    const revoked = await updatePlayer('player-9', { is_trainer: false, reason: 'Season over' });
    expect(revoked.ok).toBe(true);
    // false, not undefined: revoking has to actually write.
    expect(state.updates).toContainEqual({ table: 'players', values: { is_trainer: false } });
  });

  it('accepts the shape the admin UI sends when is_trainer did not change', async () => {
    // edit-form.tsx sends `isAdmin && changed ? value : undefined`. For an exec
    // the key is present and undefined — which must not count as supplying it,
    // or every exec's Save breaks (the bug `role` already had).
    asExec();
    const res = await updatePlayer('player-9', {
      status: 'competitive',
      is_trainer: undefined,
      reason: 'Ordinary status change',
    });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { status: 'competitive' } });
  });
});

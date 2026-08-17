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

type Actor = {
  id: string;
  role: string;
  is_exec?: boolean;
  is_trainer?: boolean;
  // The three permission columns. The gate mock resolves them now, because an
  // officer's writes arrive from a permission_role rather than from `is_exec`.
  permission_role?: string;
  permission_grants?: string[];
  permission_revokes?: string[];
};

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
// IT READS THE ACTOR'S STORED PERMISSIONS NOW, NOT JUST THEIR LEVEL, which is
// what the real requireCapability has always done and what this mock could get
// away with skipping only while an officer's writes came from their level. They
// come from a permission_role since the baseline narrowed to twelve reads, so a
// mock forcing UNRESTRICTED would model an officer nobody has given a job to —
// and every exec case in this file is about somebody doing the roster job.
//
// The wording is denialFor()'s FOUR branches in the order it asks them, not
// three of them — including the one that answers first. A console user refused
// something the ceiling allows is told it is their permissions rather than their
// level, and that is now the commonest refusal in the app; a mock that skipped
// it would assert wording the shipped function no longer produces, in the one
// file that claims to copy it.
vi.mock('../actions/_shared', async () => {
  const {
    accessLevelFor, permissionsOf, permits,
    EDITOR_OFFERABLE, EXEC_ASSIGNABLE, TRAINER_BASELINE,
  } = await import('../permissions');
  return {
    requireCapability: async (capability: Capability) => {
      const level = accessLevelFor(state.actor);
      if (!permits(level, permissionsOf(level, state.actor), capability)) {
        throw new Error(
          level !== null && EDITOR_OFFERABLE.includes(capability)
            ? 'Your permissions do not include this. Ask an admin.'
            : TRAINER_BASELINE.includes(capability)
              ? 'Admin console access required'
              : EXEC_ASSIGNABLE.includes(capability)
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

// AN OFFICER DOING THE ROSTER JOB, which is what every `asExec()` case in this
// file has always been about. The row grew a permission_role because the exec
// baseline is twelve reads now: `players.update.write` and the rest of roster
// management arrive from ROLE_DEFAULTS.internal rather than from `is_exec`. The
// FIELD-LEVEL boundary this suite exists to pin — status yes, ratings no,
// role/is_exec/is_trainer never — is decided by assertPlayerFieldAccess on the
// resolved LEVEL and is completely untouched by the role.
const asExec = () => {
  state.actor = {
    id: 'exec-1',
    role: 'player',
    is_exec: true,
    permission_role: 'internal',
    permission_grants: [],
    permission_revokes: [],
  };
};
// ...AND THE OFFICER NOBODY HAS ASSIGNED ANYTHING TO, who is the new default on
// production and the reason the narrowing needs somebody on /permissions the
// same day. Used by the case below that pins what they can no longer do.
const asUnassignedExec = () => {
  state.actor = { id: 'exec-0', role: 'player', is_exec: true };
};
const asAdmin = () => { state.actor = { id: 'admin-1', role: 'admin' }; };
// A PURE varsity trainer: no exec marker, not an admin.
const asTrainer = () => { state.actor = { id: 'trainer-1', role: 'player', is_trainer: true }; };
// Someone who trains the varsity squad AND sits on the exec. The club owner's
// composition rule: they get exec powers, because the restriction follows the
// level a person resolves to, not the flag in isolation.
const asExecTrainer = () => {
  state.actor = {
    id: 'exec-trainer-1',
    role: 'player',
    is_exec: true,
    is_trainer: true,
    permission_role: 'internal',
    permission_grants: [],
    permission_revokes: [],
  };
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

  // `as never` on every console-access payload below, here and throughout: the
  // three columns are no longer declared on adminPlayerUpdateSchema, so TypeScript
  // rejects them at the call site. That is the FIRST line of the enforcement and
  // is worth stating — a typed caller cannot express the request at all. The cast
  // is what lets these tests reach past it and prove the RUNTIME refusal too,
  // which is the line a hand-rolled POST actually meets.
  it('rejects an exec who supplies role — this is the escalation path', async () => {
    asExec();
    const res = await updatePlayer('player-9', { role: 'admin', reason: 'Promoting myself' } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Admin access required');
    // Rejected outright, not silently stripped: nothing was written.
    expect(state.updates).toEqual([]);
  });

  it('rejects an exec who supplies is_exec', async () => {
    asExec();
    const res = await updatePlayer('player-9', { is_exec: true, reason: 'Adding a friend to the exec team' } as never);
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
    const res = await updatePlayer('player-9', { status: 'competitive', is_exec: true, reason: 'Mixed payload' } as never);
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
      exec_title: undefined,
      exec_photo_url: undefined,
      fee_exempt: undefined,
      reason: 'Ordinary status change from the edit form',
    });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { status: 'competitive' } });
  });

  // A TAB OPENED BEFORE THIS DEPLOY still renders the console-access select and
  // still builds `role: changed ? value : undefined`. Unchanged, that is a key
  // present and undefined, and the new refusal is presence-based like every other
  // guard here — so the stale client's ordinary Save must still work. If this
  // ever flipped to "key exists", every open admin tab would start failing on a
  // status change until it was reloaded.
  it('accepts an old client that still names the console fields but changed none of them', async () => {
    asAdmin();
    const res = await updatePlayer('player-9', {
      status: 'competitive',
      role: undefined,
      is_exec: undefined,
      is_trainer: undefined,
      reason: 'Save from a tab opened before the dropdown was removed',
    } as never);
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { status: 'competitive' } });
  });

  it('lets an admin change fee_exempt', async () => {
    asAdmin();
    const res = await updatePlayer('player-9', { fee_exempt: true, reason: 'Waiving a contributor’s fee' });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { fee_exempt: true } });
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

// ---------------------------------------------------------------------------
// CONSOLE ACCESS HAS ONE PATH, AND IT IS NOT THIS ONE
// ---------------------------------------------------------------------------
// The club owner, looking at the member Edit dialog's "Console access" select:
// "i dont think the console access should be there anymore… since execs wouldnt
// require it anymore… as its only admins who will be mainly editing permissions."
//
// Removing the control answers the rendering half. This block is the other half,
// and it is the one that matters: updatePlayer is a server action, so it is a
// public endpoint, and a field nothing renders is still a field a hand-rolled
// POST can send.
//
// THE ACTOR HERE IS AN ADMIN ON PURPOSE. An exec being refused proves only that
// the level guard still works — it did before this change too. What is new is
// that the SENIOR caller is refused as well, because the refusal is about where
// the act lives rather than about who is asking. /permissions → setConsoleAccess
// is where it lives, and that path has a self-edit refusal, an admin-target
// refusal, grant closure on the target's resolved set in both directions, a
// required reason and composition clearing. None of those is reachable from here.
describe('updatePlayer cannot set a console-access column, not even for an admin', () => {
  it.each([
    ['role', { role: 'admin' }],
    ['is_exec', { is_exec: true }],
    ['is_trainer', { is_trainer: true }],
  ])('refuses an admin who supplies %s, and writes nothing', async (field, payload) => {
    asAdmin();
    const res = await updatePlayer('player-9', { ...payload, reason: 'Promoting a friend' } as never);
    expect(res.ok, `an admin was allowed to send ${field}`).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('Permissions page');
      expect(res.error).toContain(field);
    }
    // THE ROW, NOT JUST THE REFUSAL. `ok === false` alone would still pass if the
    // write had landed and something downstream had thrown.
    expect(state.updates).toEqual([]);
  });

  // REVOKING IS THE SAME ACT AS GRANTING, so `false` is refused exactly as `true`
  // is. A guard that only stopped the truthy value would leave "take somebody's
  // console away" on a screen with no audit of who else holds what.
  it.each([
    ['is_exec', { is_exec: false }],
    ['is_trainer', { is_trainer: false }],
  ])('refuses an admin REVOKING through %s too', async (_field, payload) => {
    asAdmin();
    const res = await updatePlayer('player-9', { ...payload, reason: 'Season over' } as never);
    expect(res.ok).toBe(false);
    expect(state.updates).toEqual([]);
  });

  // The permitted half must not land either — the same rule the mixed-payload
  // case above pins for an exec, asserted for the new refusal because it is a
  // different guard at a different line.
  it('refuses the whole request when a console column rides along with an allowed field', async () => {
    asAdmin();
    const res = await updatePlayer('player-9', {
      status: 'competitive',
      is_exec: true,
      reason: 'Status change with a promotion smuggled in',
    } as never);
    expect(res.ok).toBe(false);
    expect(state.updates).toEqual([]);
  });

  // The three columns and no more. membership_type reads like a level to
  // somebody skimming and is not one, so it must not be caught by this guard —
  // an exec correcting somebody's membership is ordinary roster work.
  it('names exactly the three columns and leaves ordinary fields alone', async () => {
    const { CONSOLE_ACCESS_FIELDS, assertNoConsoleAccessFields } =
      await import('../player-field-access');
    expect([...CONSOLE_ACCESS_FIELDS]).toEqual(['role', 'is_exec', 'is_trainer']);

    expect(() => assertNoConsoleAccessFields([{ membership_type: 'alumni' }])).not.toThrow();
    expect(() => assertNoConsoleAccessFields([{ status: 'competitive' }])).not.toThrow();
    // Keys present but undefined are not supplied — the same presence rule the
    // rest of this file pins, so an old client sending an unchanged field saves.
    expect(() => assertNoConsoleAccessFields([{ role: undefined }])).not.toThrow();
    expect(() => assertNoConsoleAccessFields([{}])).not.toThrow();
    // BOTH PAYLOADS, for the reason the exec_title case above exists: zod strips
    // these keys now, so a check against the parsed object alone is vacuous.
    expect(() => assertNoConsoleAccessFields([{ is_exec: true }, {}]))
      .toThrowError(/Permissions page/);
  });
});

// ---------------------------------------------------------------------------
// membership_type is on NEITHER list, and that is a decision
// ---------------------------------------------------------------------------
// A privilege audit flagged this as the strongest-looking omission in the guard,
// and its arithmetic is right: selectFeeTier() takes three inputs off the player
// row — membership_type, is_exec and fee_exempt — and the other two ARE on the
// lists, so an exec can move a member to whichever group the cheapest tier names.
// The decision is to leave it off both, because membership_type is primarily who
// a member is (isMembershipAllowed decides which events they may enter at all)
// rather than what they pay, and because the near miss — PLAYER_FIELD_PRIVILEGED —
// would make it admin-only, since players.privilegedfields.write sits in no
// baseline. See the note in player-field-access.ts for the whole argument.
//
// PINNED HERE because it was previously recorded nowhere. competition_category
// carries a comment saying the same thing about itself; this field had no comment
// and no test, which is precisely what made it read as an oversight rather than a
// choice. A future change that moves it onto either list now has to delete an
// assertion, and reach the argument on the way.
describe('membership_type is exec-writable on purpose', () => {
  it('is on neither PLAYER_FIELD_FLOOR nor PLAYER_FIELD_PRIVILEGED', async () => {
    const { PLAYER_FIELD_FLOOR, PLAYER_FIELD_PRIVILEGED, ADMIN_ONLY_PLAYER_FIELDS } =
      await import('../player-field-access');
    expect([...PLAYER_FIELD_FLOOR]).not.toContain('membership_type');
    expect([...PLAYER_FIELD_PRIVILEGED]).not.toContain('membership_type');
    expect([...ADMIN_ONLY_PLAYER_FIELDS]).not.toContain('membership_type');
    // The two fee inputs that ARE admin-only, asserted beside it so the split
    // reads as the deliberate one it is rather than as three fields nobody
    // classified. is_exec skips the fee for every event, silently; fee_exempt
    // does the same by name; membership_type chooses which price applies.
    expect([...PLAYER_FIELD_FLOOR]).toContain('is_exec');
    expect([...PLAYER_FIELD_PRIVILEGED]).toContain('fee_exempt');
  });

  it('lets an exec correct a member’s group, and audits it with a reason', async () => {
    asExec();
    const res = await updatePlayer('player-9', {
      membership_type: 'alumni',
      reason: 'Graduated last term',
    });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { membership_type: 'alumni' } });
  });

  it('is still refused to a varsity trainer, who may write nothing at all', async () => {
    asTrainer();
    const res = await updatePlayer('player-9', { membership_type: 'external', reason: 'Trying it on' });
    expect(res.ok).toBe(false);
    expect(state.updates).toEqual([]);
  });

  it('does not let the fee fields ride along with it', async () => {
    // The whole reason the field is safe to leave open: it chooses a price, it
    // does not skip one. An exec reaching for both in one payload is refused
    // outright, membership_type included — the guard rejects rather than strips.
    asExec();
    const res = await updatePlayer('player-9', {
      membership_type: 'alumni',
      fee_exempt: true,
      reason: 'Both at once',
    });
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
  // THE WORDING CHANGED AND THE REFUSAL DID NOT. This asserted the message
  // contained 'exec', because a trainer meeting `players.update.write` used to
  // be told "Admin or exec access required" — the level that held it. Nobody
  // holds it by level any more, so denialFor answers the true question instead:
  // a trainer CAN be composed to hold roster writes (they have been composable
  // since 00090), so the thing standing between them and this action is their
  // permissions, and that is what they are told. The assertion follows the
  // message rather than the message being kept to suit the assertion.
  it('is turned away by updatePlayer before any field is even looked at', async () => {
    asTrainer();
    const res = await updatePlayer('player-9', { status: 'competitive', reason: 'Trying it on' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('Your permissions do not include this. Ask an admin.');
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

// THE COMPOSITION, AND THE ONE PLACE THE NARROWING COSTS SOMETHING. accessLevelFor
// resolves is_exec BEFORE is_trainer and returns ONE level, so this row is an
// 'exec' and holds the exec baseline — which used to contain the trainer's whole
// level and no longer does. `players.editor.varsitynotes.write` is a write, so it
// left the floor with the other sixty, and a row carrying both flags now LOSES
// the note unless a role or a grant brings it back. The `internal` role above is
// exactly that repair, and the case below asserts it works.
//
// It is latent rather than live because fromRoleValue() writes the two flags
// mutually exclusively, so only a legacy row can be both — see the pinned hole in
// packages/shared/src/utils/__tests__/capabilities.test.ts, where the reasoning
// and the two possible fixes are set out.
describe('trainer composes with exec', () => {
  it('an exec who is also a trainer keeps every exec power', async () => {
    asExecTrainer();
    const res = await updatePlayer('player-9', { status: 'competitive', reason: 'Ordinary exec work' });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { status: 'competitive' } });
  });

  it('...and is still not an admin', async () => {
    asExecTrainer();
    const res = await updatePlayer('player-9', { is_exec: true, reason: 'Promoting a friend' } as never);
    expect(res.ok).toBe(false);
    expect(state.updates).toEqual([]);
  });

  // ASSERTED THROUGH fee_exempt RATHER THAN is_trainer, which is what it used to
  // use. is_trainer is refused for everybody now, so a passing assertion on it
  // would say nothing about admin power — it would pass for an exec too. The
  // claim is "the trainer flag does not cost an admin their admin fields", and
  // fee_exempt is an admin field this action still writes.
  it('an admin who is also a trainer keeps every admin power', async () => {
    state.actor = { id: 'admin-trainer-1', role: 'admin', is_trainer: true };
    const res = await updatePlayer('player-9', { fee_exempt: true, reason: 'Waiving a fee' });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { fee_exempt: true } });
  });
});

// is_trainer was admin-only here, exactly like is_exec. It is now NOBODY's
// through this action — appointing a varsity trainer is console access and goes
// through /permissions with the other two. What survives is the exec refusal,
// because the wording an exec gets is a different sentence from the one an admin
// gets and both are worth pinning; the admin half lives in the console-access
// block above.
describe('is_trainer is console access, like role and is_exec', () => {
  it('rejects an exec who supplies is_trainer, naming the field', async () => {
    asExec();
    const res = await updatePlayer('player-9', { is_trainer: true, reason: 'Appointing a trainer' } as never);
    expect(res.ok).toBe(false);
    // The LEVEL guard answers first for an exec — "Admin access required" — which
    // is the true shape of their refusal: they may not do it anywhere, whereas an
    // admin may, just not here.
    if (!res.ok) expect(res.error).toContain('is_trainer');
    expect(state.updates).toEqual([]);
  });

  it('accepts the shape an old admin UI sends when is_trainer did not change', async () => {
    // edit-form.tsx used to send `isAdmin && changed ? value : undefined`. For an
    // exec the key was present and undefined — which must not count as supplying
    // it, or every exec's Save breaks (the bug `role` already had).
    asExec();
    const res = await updatePlayer('player-9', {
      status: 'competitive',
      is_trainer: undefined,
      reason: 'Ordinary status change',
    } as never);
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { status: 'competitive' } });
  });
});

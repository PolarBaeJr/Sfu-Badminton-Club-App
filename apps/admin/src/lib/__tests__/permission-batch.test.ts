import { describe, it, expect, vi } from 'vitest';
import {
  draftOf,
  dropPending,
  isDirty,
  localRefusal,
  normalise,
  pendingEntries,
  saveBatch,
  totalChanges,
  type BatchPerson,
  type Draft,
  type PendingEdits,
} from '../permission-batch';
import { EXEC_BASELINE, ROLE_DEFAULTS, type Capability } from '../permissions';

// EDITING SEVERAL PEOPLE BEFORE SAVING ANY OF THEM.
//
// Three things are pinned here, and they are the three that would hurt if they
// broke. First, that a queued change is only ever a change somebody MADE — the
// rail marker and the save bar are both driven off this, and a spurious entry is
// a batch the admin did not ask for. Second, that the counts add up across
// people rather than describing whoever happens to be selected. Third, and the
// one worth the file on its own: that a single local refusal writes NOTHING.
//
// The refusals themselves are a transcription of setPlayerPermissions' checks
// (see ./grant-closure.test.ts for the checks as the SERVER runs them, which is
// where the boundary actually is). What is tested here is that the editor
// refuses the same things early, so a batch of five is turned away whole instead
// of writing two and stopping.

const exec = (over: Partial<BatchPerson> = {}): BatchPerson => ({
  id: 'alice',
  name: 'Alice',
  level: 'exec',
  role: null,
  grants: [],
  revokes: [],
  ...over,
});

const draft = (over: Partial<Draft> = {}): Draft => ({
  role: null,
  grants: [],
  revokes: [],
  ...over,
});

/** Every capability an unrestricted exec holds — what a level default resolves to. */
const BASELINE = [...EXEC_BASELINE];
const FINANCE = [...ROLE_DEFAULTS.finance];
const admin = { id: 'admin', held: new Set<Capability>(BASELINE) };

describe('who has something queued', () => {
  it('leaves out anybody with no entry at all', () => {
    const people = [exec(), exec({ id: 'ben', name: 'Ben' })];
    expect(pendingEntries(people, {})).toEqual([]);
  });

  it('leaves out an entry that has been edited back to what is stored', () => {
    const person = exec({ role: 'finance', grants: ['announcements.page'] });
    expect(pendingEntries([person], { alice: draftOf(person) })).toEqual([]);
  });

  // THE REASON THE MAP HOLDS ONLY TOUCHED PEOPLE. A draft is read through this
  // build's vocabulary and compared against the row as STORED, so somebody
  // carrying an element the code no longer knows is "dirty" the moment a draft
  // exists for them. Seeding one for everybody to compute the rail markers would
  // put a marker and a save-bar entry on a person nobody has touched.
  it('would mark an untouched person carrying an unknown capability, if it seeded one', () => {
    const person = exec({ role: 'finance', grants: ['fees.page', 'a.capability.that.went.away'] });
    expect(isDirty(person, draftOf(person))).toBe(true);
    expect(pendingEntries([person], {})).toEqual([]);
  });

  it('keeps the order the people were listed in', () => {
    const people = [
      exec({ id: 'alice', name: 'Alice' }),
      exec({ id: 'ben', name: 'Ben' }),
      exec({ id: 'chen', name: 'Chen' }),
    ];
    const pending: PendingEdits = {
      chen: draft({ role: 'finance' }),
      alice: draft({ role: 'finance' }),
    };
    expect(pendingEntries(people, pending).map((e) => e.person.id)).toEqual(['alice', 'chen']);
  });
});

describe('the counts across everybody', () => {
  const people = [
    exec({ id: 'alice', name: 'Alice' }),
    exec({ id: 'ben', name: 'Ben', role: 'finance' }),
    exec({ id: 'chen', name: 'Chen' }),
  ];
  const pending: PendingEdits = {
    // A level default narrowed to Finance: everything the baseline gave, gone
    // but for the three Finance keeps.
    alice: draft({ role: 'finance' }),
    // One capability added on top of a role.
    ben: draft({ role: 'finance', grants: ['announcements.page'] }),
    // The row changes and the PERSON does not — a level default turned into a
    // hand-picked set of exactly the same capabilities.
    chen: draft({ role: 'custom', grants: BASELINE as Capability[] }),
  };

  it('adds up what each edit does to the person', () => {
    const entries = pendingEntries(people, pending);
    const [alice, ben] = entries;
    expect(entries).toHaveLength(3);
    expect(alice?.gaining).toEqual([]);
    expect(alice?.losing).toHaveLength(BASELINE.length - FINANCE.length);
    expect(ben).toMatchObject({ gaining: ['announcements.page'], losing: [], changes: 1 });
    expect(totalChanges(entries)).toBe(BASELINE.length - FINANCE.length + 1);
  });

  // A person can be queued and change nothing about themselves. The bar has to
  // count them as a PERSON with something to save while reporting zero changes,
  // because the row genuinely does change — "0 changes across 3 people" is a
  // reachable and honest state, and dropping Chen would lose their save.
  it('counts a row-only change as a person with nothing to change', () => {
    const chen = pendingEntries(people, pending)[2];
    expect(chen?.person.id).toBe('chen');
    expect(chen?.changes).toBe(0);
  });
});

describe('the queue after a save', () => {
  const pending: PendingEdits = {
    alice: draft({ role: 'finance' }),
    ben: draft({ role: 'finance' }),
    chen: draft({ role: 'finance' }),
  };

  it('keeps whoever was not written', () => {
    expect(Object.keys(dropPending(pending, ['alice', 'chen']))).toEqual(['ben']);
  });

  it('empties when everybody was written', () => {
    expect(dropPending(pending, ['alice', 'ben', 'chen'])).toEqual({});
  });
});

describe('what would be stored', () => {
  it('clears both deltas when no role is set', () => {
    expect(normalise(draft({ grants: ['fees.page'], revokes: ['players.read'] }))).toEqual({
      role: null,
      grants: [],
      revokes: [],
    });
  });

  // The server drops a grant the role already gives before any closure check
  // runs, so a local check on the RAW draft would refuse batches the server
  // would have accepted.
  it('drops a grant the role already gives, and de-duplicates the rest', () => {
    expect(
      normalise(draft({ role: 'finance', grants: ['fees.page', 'players.page', 'players.page'] })),
    ).toEqual({ role: 'finance', grants: ['players.page'], revokes: [] });
  });
});

describe('refusing an edit before anything is written', () => {
  it('refuses the actor their own row', () => {
    expect(localRefusal(exec({ id: 'admin' }), draft({ role: 'finance' }), admin)).toMatch(
      /your own permissions/,
    );
  });

  it('refuses somebody with no console access', () => {
    expect(localRefusal(exec({ level: null }), draft({ role: 'finance' }), admin)).toMatch(
      /no console access/,
    );
  });

  it('refuses an admin, whose stored row is never consulted', () => {
    expect(localRefusal(exec({ level: 'admin' }), draft({ role: 'finance' }), admin)).toMatch(
      /by level/,
    );
  });

  it('refuses a grant the actor does not hold', () => {
    const actor = { id: 'treasurer', held: new Set<Capability>(FINANCE) };
    const queued = draft({ role: 'finance', grants: ['players.page'] });
    expect(localRefusal(exec(), queued, actor)).toMatch(/you do not hold players\.page/);
  });

  // THE CHECK A CLICK CAN REACH THAT NOTHING ELSE CATCHES. Every cell in the
  // tree is disabled for a capability the actor does not hold, but the "Starts
  // from" select offers all four named roles regardless — and a role REPLACES
  // the base, so its defaults arrive as neither a grant nor a revoke. Only the
  // test on the RESULT sees them.
  it('refuses a role whose defaults reach past what the actor holds', () => {
    const actor = { id: 'treasurer', held: new Set<Capability>(FINANCE) };
    const person = exec({ role: 'finance', grants: [], revokes: [] });
    expect(localRefusal(person, draft({ role: 'tournaments' }), actor)).toMatch(
      /would give them .*which you do not hold/,
    );
  });

  it('refuses editing somebody who already holds more than the actor does', () => {
    const actor = { id: 'treasurer', held: new Set<Capability>(FINANCE) };
    // On their level default, so they hold the whole exec baseline.
    expect(localRefusal(exec(), draft({ role: 'finance' }), actor)).toMatch(/they already hold/);
  });

  it('allows an edit that stays inside what the actor holds', () => {
    expect(localRefusal(exec(), draft({ role: 'finance' }), admin)).toBeNull();
  });
});

describe('saving the batch', () => {
  const entry = (id: string) => ({ id });

  it('writes nothing at all when one of five is refused', async () => {
    const write = vi.fn(async () => ({ ok: true }) as const);
    const result = await saveBatch(['a', 'b', 'c', 'd', 'e'].map(entry), {
      validate: (e) => (e.id === 'c' ? 'you do not hold players.page' : null),
      write,
    });
    expect(write).not.toHaveBeenCalled();
    expect(result.saved).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.refused).toEqual([{ id: 'c', error: 'you do not hold players.page' }]);
  });

  it('names every refusal, not just the first', async () => {
    const result = await saveBatch(['a', 'b', 'c'].map(entry), {
      validate: (e) => (e.id === 'a' ? 'one' : e.id === 'c' ? 'two' : null),
      write: async () => ({ ok: true }),
    });
    expect(result.refused.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('writes each person separately, in order', async () => {
    const written: string[] = [];
    await saveBatch(['a', 'b', 'c'].map(entry), {
      validate: () => null,
      write: async (e) => {
        written.push(e.id);
        return { ok: true };
      },
    });
    expect(written).toEqual(['a', 'b', 'c']);
  });

  // IT IS N CALLS, NOT A TRANSACTION. The first two are already written by the
  // time the third is refused and there is no taking them back, so the rest are
  // attempted anyway and the result says exactly which landed. Anything else
  // hands the admin an arbitrary prefix to work out for themselves.
  it('reports which landed when the server refuses one in the middle', async () => {
    const result = await saveBatch(['a', 'b', 'c', 'd', 'e'].map(entry), {
      validate: () => null,
      write: async (e) => (e.id === 'c' ? { ok: false, error: 'gone' } : { ok: true }),
    });
    expect(result.saved).toEqual(['a', 'b', 'd', 'e']);
    expect(result.failed).toEqual([{ id: 'c', error: 'gone' }]);
    expect(result.refused).toEqual([]);
  });

  it('leaves the one that failed still queued', async () => {
    const pending: PendingEdits = {
      a: draft({ role: 'finance' }),
      b: draft({ role: 'finance' }),
      c: draft({ role: 'finance' }),
    };
    const result = await saveBatch(['a', 'b', 'c'].map(entry), {
      validate: () => null,
      write: async (e) => (e.id === 'b' ? { ok: false, error: 'gone' } : { ok: true }),
    });
    expect(Object.keys(dropPending(pending, result.saved))).toEqual(['b']);
  });
});

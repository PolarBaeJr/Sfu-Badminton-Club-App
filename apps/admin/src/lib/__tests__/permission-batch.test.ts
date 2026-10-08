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
import { CAPABILITIES, EXEC_BASELINE, ROLE_DEFAULTS, type Capability } from '../permissions';

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
const TOURNAMENTS = [...ROLE_DEFAULTS.tournaments];

// THE ACTOR'S OWN SET, AND IT IS NOW `CAPABILITIES` RATHER THAN THE EXEC
// BASELINE. The fixture is called `admin` and closure measures an edit against
// what the ACTOR holds — an admin holds everything, by level. It was written as
// EXEC_BASELINE only because that constant used to be the widest set anybody
// handed out, so the two coincided. They stopped coinciding when the baseline
// narrowed to twelve reads, and left as it was this fixture would have refused
// the admin every write in the club: three tests below assert an edit is
// ALLOWED, and they would have been passing for the wrong reason or failing for
// a reason that has nothing to do with batching.
const admin = { id: 'admin', held: new Set<Capability>(CAPABILITIES) };

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
    // A level default turned into a VP job. THE ROLE HAD TO CHANGE FROM
    // `finance` TO `tournaments`: Finance is three fees capabilities and all
    // three are in the floor now, so assigning it changes nothing about the
    // person and this row would have been queued with zero changes, which is a
    // test of the counting that counted nothing. Tournaments still brings
    // writes. The Finance no-op is pinned on its own below.
    alice: draft({ role: 'tournaments' }),
    // One capability added on top of a role. THE GRANT HAD TO CHANGE FROM
    // `announcements.page` TO A WRITE: every section page is in the floor now,
    // so granting one adds nothing and this row would be queued with zero
    // changes — a test of the counting that counted nothing.
    ben: draft({ role: 'finance', grants: ['announcements.create.write'] }),
    // The row changes and the PERSON does not — a level default turned into a
    // hand-picked set of exactly the same capabilities.
    chen: draft({ role: 'custom', grants: BASELINE as Capability[] }),
  };

  // ALICE LOSES NOTHING AT ALL NOW, and the arithmetic has inverted three times
  // in three changes for three different reasons — which is worth spelling out,
  // because a number moving repeatedly is what a stale fixture also looks like.
  //
  //   Originally: the baseline was the historic 73 and a role REPLACED it, so
  //   narrowing Alice to Finance took 70 capabilities away and gave nothing.
  //   Then: the baseline narrowed to twelve reads, so the same edit took ten and
  //   GAVE her `fees.expenses.add.write` — the first time this test saw a gain.
  //   Then: the club owner ruled the baseline is a FLOOR under every role, so the
  //   twelve stayed and the edit was the one write, gained, nothing lost.
  //   Now: that write is IN the floor, so Finance gains nothing either and the
  //   fixture moved to Tournaments to keep measuring a real edit.
  //
  // Which is the whole ruling in one assertion: assigning somebody a job adds
  // the job. It does not quietly take their reads away.
  it('adds up what each edit does to the person', () => {
    const inBaseline = new Set<Capability>(BASELINE);
    const gained = TOURNAMENTS.filter((c) => !inBaseline.has(c));
    expect(gained.length).toBeGreaterThan(0);
    expect(gained.every((c) => c.endsWith('.write'))).toBe(true);

    const entries = pendingEntries(people, pending);
    const [alice, ben] = entries;
    expect(entries).toHaveLength(3);
    expect(alice?.gaining).toEqual(gained);
    expect(alice?.losing).toEqual([]);
    // BEN'S ROLE IS THE NO-OP AND HIS GRANT IS NOT, which is why he still counts
    // one change: Finance adds nothing on top of the floor, so the only thing
    // this row does to the person is the capability picked by hand.
    expect(ben).toMatchObject({
      gaining: ['announcements.create.write'], losing: [], changes: 1,
    });
    expect(totalChanges(entries)).toBe(gained.length + 1);
  });

  // THE FINANCE ROLE NO LONGER DOES ANYTHING, and that is a consequence of the
  // owner's 2026-09-19 request rather than a bug: "also give everyone permission
  // to write expense into the fee table" put `fees.expenses.add.write` into the
  // floor, and the floor already held `fees.page` and `fees.expenses.read`, so
  // all three of Finance's capabilities are now things every officer has.
  //
  // Pinned rather than left implicit because the CONSOLE still offers Finance as
  // a role, and an admin who assigns it gets a save that reports zero changes.
  // The day somebody widens the role, or narrows the floor, this fails and the
  // decision gets made on purpose.
  it('leaves the Finance role adding nothing on top of the floor', () => {
    const inBaseline = new Set<Capability>(BASELINE);
    expect(FINANCE.filter((c) => !inBaseline.has(c))).toEqual([]);
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
      // A baseline label is a claim about where the grants came from, so it
      // goes with them: there is nothing left for it to describe.
      baselineId: null,
    });
  });

  // The server drops a grant the role already gives before any closure check
  // runs, so a local check on the RAW draft would refuse batches the server
  // would have accepted.
  it('drops a grant the role already gives, and de-duplicates the rest', () => {
    expect(
      normalise(draft({ role: 'finance', grants: ['fees.page', 'players.page', 'players.page'] })),
    ).toEqual({ role: 'finance', grants: ['players.page'], revokes: [], baselineId: null });
  });

  // A LABEL SURVIVES ONLY ON 'custom', matching the CHECK in 00093 and the
  // refusal in setPlayerPermissions. Any other role has defaults beneath the
  // grants, so the label would be describing part of the set.
  it('keeps the baseline label on a hand-picked set and nowhere else', () => {
    const chosen: Capability[] = ['announcements.page', 'announcements.create.write'];
    expect(normalise(draft({ role: 'custom', grants: chosen, baselineId: 'b1' })).baselineId)
      .toBe('b1');
    expect(normalise(draft({ role: 'external', grants: chosen, baselineId: 'b1' })).baselineId)
      .toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CUSTOM BASELINES — the provenance label, which changes nobody's capabilities
// ---------------------------------------------------------------------------
describe('where a hand-picked set came from', () => {
  const chosen: Capability[] = ['announcements.page', 'announcements.create.write'];
  const holder = exec({ role: 'custom', grants: chosen, baselineId: 'b1' });

  it('reads the label back off the row', () => {
    expect(draftOf(holder).baselineId).toBe('b1');
  });

  // Read through the SEEDED role, like everything else in draftOf: a label on a
  // row whose role this build does not recognise describes nothing.
  it('ignores a label on a row with any other role', () => {
    expect(draftOf(exec({ role: 'finance', baselineId: 'b1' })).baselineId).toBeNull();
    expect(draftOf(exec({ role: 'treasurer', baselineId: 'b1' })).baselineId).toBeNull();
  });

  // THE LABEL ALONE IS A CHANGE WORTH SAVING. A hand-picked set that happens to
  // match a baseline and a set that came FROM one behave differently the next
  // time that baseline is edited, and only the second follows it.
  it('is dirty when only the label moves', () => {
    expect(isDirty(holder, draftOf(holder))).toBe(false);
    expect(isDirty(holder, { ...draftOf(holder), baselineId: null })).toBe(true);
    expect(isDirty(exec({ role: 'custom', grants: chosen }), {
      role: 'custom', grants: chosen, revokes: [], baselineId: 'b1',
    })).toBe(true);
  });

  // ...and it changes nothing about the PERSON, which is why dropping it is
  // safe. pendingEntries counts what an edit does to somebody, and a label
  // change does nothing at all.
  it('changes nobody when it moves', () => {
    const entries = pendingEntries([holder], {
      [holder.id]: { ...draftOf(holder), baselineId: null },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.changes).toBe(0);
    expect(totalChanges(entries)).toBe(0);
  });

  // Closure is measured on the capabilities, never on the label — a baseline
  // handing out something the actor lacks is refused exactly as a hand-picked
  // set of the same capabilities would be.
  it('is refused on the capabilities, not on where they came from', () => {
    const treasurer = { id: 'tess', held: new Set<Capability>(FINANCE) };
    expect(localRefusal(exec({ id: 'ben' }), {
      role: 'custom', grants: chosen, revokes: [], baselineId: 'b1',
    }, treasurer)).toMatch(/announcements/);
    expect(localRefusal(exec({ id: 'ben' }), {
      role: 'custom', grants: chosen, revokes: [], baselineId: 'b1',
    }, admin)).toBeNull();
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
  // THE ACTOR'S SET HAD TO GROW BY THE FLOOR, because the TARGET's now does. A
  // treasurer holding literally the three Finance capabilities cannot edit any
  // officer at all once every officer stands on twelve reads — the refusal would
  // fire on the floor, before the roles were ever compared, and this test would
  // pass while testing nothing about a role's defaults. Given the floor, it
  // tests what it says: the Tournaments job reaches past the Finance job.
  it('refuses a role whose defaults reach past what the actor holds', () => {
    const actor = {
      id: 'treasurer',
      held: new Set<Capability>([...EXEC_BASELINE, ...FINANCE]),
    };
    const person = exec({ role: 'finance', grants: [], revokes: [] });
    expect(localRefusal(person, draft({ role: 'tournaments' }), actor)).toMatch(
      /would give them .*which you do not hold/,
    );
  });

  it('refuses editing somebody who already holds more than the actor does', () => {
    const actor = { id: 'treasurer', held: new Set<Capability>(FINANCE) };
    // On their level default, so they hold the whole exec baseline — which is
    // twelve reads now, and still reaches past a treasurer's three.
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

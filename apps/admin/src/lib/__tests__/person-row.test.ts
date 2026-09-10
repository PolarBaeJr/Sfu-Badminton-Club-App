import { describe, it, expect } from 'vitest';
import { customBaselinesFrom, personRowFrom } from '../person-row';

// WHAT THIS FILE IS FOR. The permission editor's row used to be built inline on
// /permissions, twice, from two selects of deliberately different widths. It is
// now one builder with a second caller — the copy of the editor embedded on
// /players/[id] — and the whole risk of that move is the NARROW select: the
// "others" query fetches six columns, so every permission field is absent and
// has to arrive as an empty composition rather than as `undefined`. The editor
// reads `.length` off two of them.
//
// This is not a boundary. Nothing here decides who may do anything —
// setPlayerPermissions and setConsoleAccess resolve the actor's own set from the
// actor's own row and refuse everything they refuse regardless. What is pinned
// here is that both screens describe the same person the same way.

describe('the narrowed row, which is the one that can go wrong', () => {
  it('fills in every column the “others” select does not fetch', () => {
    // EXACTLY the shape permissions/page.tsx selects for members with no level:
    // 'id, full_name, email, is_banned, status, active_flag'. No role, no
    // is_exec, no is_trainer, no permission columns at all.
    const row = personRowFrom({
      id: 'p1',
      full_name: 'Kiera Tan',
      email: 'kiera@sfu.ca',
      is_banned: false,
      status: 'active',
      active_flag: true,
    });

    expect(row).toEqual({
      id: 'p1',
      name: 'Kiera Tan',
      email: 'kiera@sfu.ca',
      title: null,
      level: null,
      canSignIn: true,
      role: null,
      grants: [],
      revokes: [],
      baselineId: null,
    });
  });

  it('gives the deltas as empty arrays, never undefined', () => {
    // The specific defect: the editor reads `grants.length` on every row it
    // lists, and `personBadge` adds the two lengths together. An absent column
    // arriving as `undefined` is a thrown render, not a wrong badge.
    const row = personRowFrom({ id: 'p1' });
    expect(Array.isArray(row.grants)).toBe(true);
    expect(Array.isArray(row.revokes)).toBe(true);
  });
});

describe('the level, which is what lets one builder serve both populations', () => {
  it('reads an admin off the role column', () => {
    expect(personRowFrom({ id: 'p1', role: 'admin' }).level).toBe('admin');
  });

  it('reads an exec off the flag, and passes the whole triple through', () => {
    const row = personRowFrom({
      id: 'p1',
      full_name: 'Ravi Singh',
      exec_title: 'VP Finance',
      is_exec: true,
      permission_role: 'finance',
      permission_grants: ['fees.expenses.add.write'],
      permission_revokes: ['fees.clubfees.read'],
      permission_baseline_id: 'b1',
    });

    expect(row.level).toBe('exec');
    expect(row.title).toBe('VP Finance');
    expect(row.role).toBe('finance');
    expect(row.grants).toEqual(['fees.expenses.add.write']);
    expect(row.revokes).toEqual(['fees.clubfees.read']);
    expect(row.baselineId).toBe('b1');
  });

  it('gives a plain member no level and an empty triple', () => {
    const row = personRowFrom({ id: 'p1', role: 'player' });
    expect(row.level).toBeNull();
    expect(row.role).toBeNull();
    expect(row.grants).toEqual([]);
    expect(row.revokes).toEqual([]);
  });

  it('keeps a stored capability this build does not know', () => {
    // NOT filtered through the vocabulary, and this is what pins the mapping as
    // unchanged. draftOf() in permission-batch.ts filters the deltas, and
    // isDirty() compares that filtered draft against the row AS STORED — so a
    // string the code no longer recognises has to survive this far or the
    // comparison has nothing to notice. It is also what the `N custom` badge
    // counts.
    const row = personRowFrom({
      id: 'p1',
      is_exec: true,
      permission_grants: ['fees.expenses.add.write', 'fees.retired.write'],
    });
    expect(row.grants).toEqual(['fees.expenses.add.write', 'fees.retired.write']);
  });
});

describe('standing, which is a separate answer from the level', () => {
  it('holds the level and still cannot sign in', () => {
    // The two are asked separately because a banned executive holds the level
    // and cannot get through the front door — which is why readOnlyReason and
    // the console-access offer are separate rules rather than one.
    const row = personRowFrom({ id: 'p1', is_exec: true, is_banned: true });
    expect(row.level).toBe('exec');
    expect(row.canSignIn).toBe(false);
  });
});

describe('the name, which every list is sorted and searched by', () => {
  it('falls back from full_name to email to Unnamed', () => {
    expect(personRowFrom({ id: 'p1', full_name: 'Kiera Tan', email: 'k@sfu.ca' }).name)
      .toBe('Kiera Tan');
    expect(personRowFrom({ id: 'p1', email: 'k@sfu.ca' }).name).toBe('k@sfu.ca');
    expect(personRowFrom({ id: 'p1' }).name).toBe('Unnamed');
  });
});

describe('customBaselinesFrom', () => {
  it('drops a capability string this build does not know', () => {
    // FILTERED here, unlike a person's deltas, and for the opposite reason: a
    // baseline is an OFFER, and offering a capability the app cannot deliver is
    // a promise the resolver will not keep.
    const [baseline] = customBaselinesFrom([
      { id: 'b1', name: 'Socials', capabilities: ['players.read', 'socials.tiktok.write'] },
    ]);
    expect(baseline!.capabilities).toEqual(['players.read']);
  });

  it('nulls a builtin_role it does not recognise', () => {
    expect(customBaselinesFrom([{ id: 'b1', name: 'Socials', builtin_role: 'quartermaster' }])[0])
      .toEqual({ id: 'b1', name: 'Socials', capabilities: [], builtinRole: null });
  });

  it('keeps a builtin_role it does recognise, which is what labels the picker', () => {
    // To somebody assigning it, Finance is still Finance and not
    // "Baseline — Finance".
    expect(
      customBaselinesFrom([{ id: 'b1', name: 'Finance', builtin_role: 'finance' }])[0]!.builtinRole,
    ).toBe('finance');
  });
});

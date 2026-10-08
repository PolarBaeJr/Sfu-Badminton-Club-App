import { describe, it, expect } from 'vitest';
import {
  ACCESS_CHANGE_ACTION_TYPES,
  DANGEROUS_CAPABILITIES,
  capabilityDelta,
  isAccessChange,
  officerAccessSummary,
  type OfficerInput,
} from '../officer-access';
import { CAPABILITY_GATES } from '@badminton/shared/src/utils/capability-gates';

// The whole point of the ACCESS RIGHT NOW card is that its figures come from
// effectiveCapabilities() and not from `is_exec`. These cases are the four ways
// those two answers come apart — an admin with no stored set, an unrestricted
// exec, a NARROWED exec, and somebody who holds a level but cannot sign in.

const admin: OfficerInput = { role: 'admin' };
const unrestrictedExec: OfficerInput = { role: 'player', is_exec: true };
const trainer: OfficerInput = { role: 'player', is_trainer: true };

/** An exec composed down to a named role — the case a role-name count misses. */
const externalExec: OfficerInput = {
  role: 'player',
  is_exec: true,
  permission_role: 'external',
  permission_grants: [],
  permission_revokes: [],
};

/**
 * An exec who was ASSIGNED the roster, which is the only way anybody below admin
 * holds a dangerous capability now. It replaces `unrestrictedExec` in the two
 * counting cases below: the card counts who can ban and edit members TONIGHT,
 * and after the narrowing that is people with a permission_role and nobody else.
 */
const internalExec: OfficerInput = {
  role: 'player',
  is_exec: true,
  permission_role: 'internal',
  permission_grants: [],
  permission_revokes: [],
};

describe('officerAccessSummary', () => {
  it('counts an admin for every dangerous capability', () => {
    const summary = officerAccessSummary([admin]);
    expect(summary.rows.map((row) => row.count)).toEqual([1, 1, 1, 1, 1]);
  });

  // THE EXPECTATIONS FLIPPED FROM 1 TO 0, AND THAT IS THE CHANGE THIS CARD
  // EXISTS TO SHOW. It used to read "editing and banning are exec work" and
  // count them as held. The exec baseline is now twelve reads, so an officer
  // nobody has assigned anything to holds NONE of the five dangerous
  // capabilities — which is the club owner's instruction ("everyone can read
  // things, but cant write it") arriving on the screen that reports it.
  //
  // The other three were already 0 and stay 0: removing a member, club money
  // and handing out permissions were never exec work and are not reachable by
  // any of this.
  it('gives an unrestricted exec a read-only baseline — no dangerous capability at all', () => {
    const summary = officerAccessSummary([unrestrictedExec]);
    expect(summary.rows.every((row) => row.count === 0)).toBe(true);
    expect(summary.headline).toBe(0);
    // ...and they ARE counted as an officer who can sign in, which is what makes
    // the zero meaningful rather than an empty list.
    expect(summary.active).toBe(1);
  });

  // ...AND THE ASSIGNED OFFICER, WHO IS WHERE THOSE COUNTS LIVE NOW. Same level,
  // same person; the permission_role is the entire difference.
  it('counts an exec who was assigned the roster', () => {
    const summary = officerAccessSummary([internalExec]);
    const held = Object.fromEntries(summary.rows.map((row) => [row.capability, row.count]));
    expect(held['players.update.write']).toBe(1);
    expect(held['players.ban.write']).toBe(1);
    // Still nothing above the job: removing, club money and permissions are not
    // in ROLE_DEFAULTS.internal and no role can reach them.
    expect(held['players.remove.write']).toBe(0);
    expect(held['fees.clubfees.markpaid.write']).toBe(0);
    expect(held['permissions.write']).toBe(0);
  });

  it('does not count a narrowed exec whose role never reaches the roster', () => {
    // THE CASE A ROLE-NAME COUNT GETS WRONG. `is_exec` is true on both, so "2
    // execs can edit members" would be the answer; the external role holds
    // announcements and legal only, so the real answer is 1.
    //
    // THE OTHER OFFICER USED TO BE THE UNRESTRICTED ONE AND IS NOW THE ASSIGNED
    // ONE, because after the narrowing an unrestricted officer would have made
    // this 0 versus 0 — true, but no longer a case where a role-name count and
    // a capability count DISAGREE, which is the only thing this test is for.
    const summary = officerAccessSummary([internalExec, externalExec]);
    const held = Object.fromEntries(summary.rows.map((row) => [row.capability, row.count]));
    expect(summary.active).toBe(2);
    expect(held['players.update.write']).toBe(1);
    expect(held['players.ban.write']).toBe(1);
  });

  it('holds a trainer to their three capabilities', () => {
    const summary = officerAccessSummary([trainer]);
    expect(summary.rows.every((row) => row.count === 0)).toBe(true);
  });

  it('withholds somebody who holds a level but cannot sign in', () => {
    // A banned exec still resolves to the exec level — accessLevelFor ignores
    // standing — but the console refuses them at the door, so they must not be
    // counted among the people who could act tonight.
    const banned: OfficerInput = { ...unrestrictedExec, is_banned: true };
    const summary = officerAccessSummary([admin, banned]);
    expect(summary.total).toBe(2);
    expect(summary.active).toBe(1);
    expect(summary.withheld).toBe(1);
    expect(summary.headline).toBe(1);
  });

  it('reports zeroes rather than throwing for an empty club', () => {
    const summary = officerAccessSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.rows.map((row) => row.count)).toEqual([0, 0, 0, 0, 0]);
  });

  it('labels every row with the vocabulary its own wording', () => {
    const summary = officerAccessSummary([admin]);
    for (const row of summary.rows) {
      expect(row.label).toBe(CAPABILITY_GATES[row.capability].label);
    }
  });

  it('names one capability per row, with no duplicates', () => {
    expect(new Set(DANGEROUS_CAPABILITIES).size).toBe(DANGEROUS_CAPABILITIES.length);
  });
});

describe('isAccessChange', () => {
  it('accepts every permissions change', () => {
    expect(isAccessChange({ action_type: 'player_permissions_changed' })).toBe(true);
  });

  it('accepts a player_updated row that moved a console level', () => {
    // What setConsoleAccess writes through updatePlayer/fromRoleValue.
    expect(
      isAccessChange({
        action_type: 'player_updated',
        new_value: { role: 'player', is_exec: true, is_trainer: false },
      }),
    ).toBe(true);
  });

  it('rejects an ordinary member edit', () => {
    expect(
      isAccessChange({ action_type: 'player_updated', new_value: { first_name: 'Aiko' } }),
    ).toBe(false);
  });

  it('rejects unrelated audit rows and malformed values', () => {
    expect(isAccessChange({ action_type: 'player_banned' })).toBe(false);
    expect(isAccessChange({ action_type: 'player_updated' })).toBe(false);
    expect(isAccessChange({ action_type: 'player_updated', new_value: null })).toBe(false);
    expect(isAccessChange({ action_type: 'player_updated', new_value: 'is_exec' })).toBe(false);
  });

  it('fetches exactly the action types it can narrow', () => {
    expect([...ACCESS_CHANGE_ACTION_TYPES].every((type) => isAccessChange({
      action_type: type,
      new_value: { is_exec: true },
    }))).toBe(true);
  });
});

describe('capabilityDelta', () => {
  it('counts what a permissions change added and removed', () => {
    const delta = capabilityDelta(
      { effective: ['players.page', 'players.read'] },
      { effective: ['players.page', 'fees.page', 'fees.expenses.read'] },
    );
    expect(delta).toEqual({ added: 2, removed: 1 });
  });

  it('returns null rather than a zero for a row with no resolved sets', () => {
    // A `player_updated` row has no `effective` snapshot, and "no data" must not
    // render as "nothing changed".
    expect(capabilityDelta({ role: 'player' }, { is_exec: true })).toBeNull();
    expect(capabilityDelta(null, null)).toBeNull();
    expect(capabilityDelta({ effective: ['players.page'] }, { effective: 'nope' })).toBeNull();
  });
});

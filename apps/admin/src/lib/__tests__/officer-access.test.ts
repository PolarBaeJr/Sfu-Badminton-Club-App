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

describe('officerAccessSummary', () => {
  it('counts an admin for every dangerous capability', () => {
    const summary = officerAccessSummary([admin]);
    expect(summary.rows.map((row) => row.count)).toEqual([1, 1, 1, 1, 1]);
  });

  it('gives an unrestricted exec the exec baseline and nothing above it', () => {
    const summary = officerAccessSummary([unrestrictedExec]);
    const held = Object.fromEntries(summary.rows.map((row) => [row.capability, row.count]));
    // Editing and banning are exec work; removing, club money and handing out
    // permissions never were.
    expect(held['players.update.write']).toBe(1);
    expect(held['players.ban.write']).toBe(1);
    expect(held['players.remove.write']).toBe(0);
    expect(held['fees.clubfees.markpaid.write']).toBe(0);
    expect(held['permissions.write']).toBe(0);
  });

  it('does not count a narrowed exec whose role never reaches the roster', () => {
    // THE CASE A ROLE-NAME COUNT GETS WRONG. `is_exec` is true, so "2 execs can
    // edit members" would be the answer; the external role holds announcements
    // and legal only, so the real answer is 1.
    const summary = officerAccessSummary([unrestrictedExec, externalExec]);
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

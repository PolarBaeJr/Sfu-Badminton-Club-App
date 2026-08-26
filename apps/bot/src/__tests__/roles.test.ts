import { describe, it, expect } from 'vitest';
import {
  desiredRoles,
  parseGuildRegistry,
  roleDiff,
  MANAGED_ROLES,
  type MemberState,
} from '../roles.js';

function member(overrides: Partial<MemberState> = {}): MemberState {
  return {
    status: 'recreational',
    membershipType: 'internal',
    isExec: false,
    isBanned: false,
    permissionRole: null,
    capabilities: [],
    ...overrides,
  };
}

describe('MANAGED_ROLES', () => {
  // The one entry whose ABSENCE is the requirement. Admin is managed by hand,
  // is lock-icon'd in Discord, and a bot cannot assign it regardless.
  it('does not include admin', () => {
    expect(MANAGED_ROLES).not.toContain('admin');
  });

  it('does not include a member role', () => {
    // Internal + Alumni + External already partition membership exactly; a
    // fourth role would be a second, drifting source of truth for the same fact.
    expect(MANAGED_ROLES).not.toContain('member');
  });
});

describe('desiredRoles', () => {
  it('gives every linked member the linked role', () => {
    expect(desiredRoles(member())).toContain('linked');
  });

  it('maps membership_type to exactly one membership role', () => {
    expect(desiredRoles(member({ membershipType: 'internal' })).has('internal')).toBe(true);
    expect(desiredRoles(member({ membershipType: 'alumni' })).has('alumni')).toBe(true);
    expect(desiredRoles(member({ membershipType: 'external' })).has('external')).toBe(true);

    const alumni = desiredRoles(member({ membershipType: 'alumni' }));
    expect(alumni.has('internal')).toBe(false);
    expect(alumni.has('external')).toBe(false);
  });

  it('maps status to the team roles', () => {
    expect(desiredRoles(member({ status: 'competitive' })).has('competitive')).toBe(true);
    expect(desiredRoles(member({ status: 'recreational' })).has('recreation')).toBe(true);
  });

  it('gives an exec the executives role', () => {
    expect(desiredRoles(member({ isExec: true })).has('executives')).toBe(true);
  });

  it('gives a VP role only to an exec holding one of the four named jobs', () => {
    for (const job of ['finance', 'tournaments', 'internal', 'external'] as const) {
      const roles = desiredRoles(member({ isExec: true, permissionRole: job }));
      expect(roles.has('vp'), job).toBe(true);
      // VP is a subset of Executives, never an alternative to it.
      expect(roles.has('executives'), job).toBe(true);
    }
  });

  it('does not treat custom as a VP job', () => {
    // access-level.ts: "`custom` IS NOT A FIFTH VP JOB. It is the empty base".
    const roles = desiredRoles(member({ isExec: true, permissionRole: 'custom' }));
    expect(roles.has('vp')).toBe(false);
    expect(roles.has('executives')).toBe(true);
  });

  it('does not give VP to a non-exec carrying a permission role', () => {
    const roles = desiredRoles(member({ isExec: false, permissionRole: 'finance' }));
    expect(roles.has('vp')).toBe(false);
  });

  it('requires BOTH session capabilities for session staff', () => {
    const both = desiredRoles(
      member({ capabilities: ['sessions.attendance.write', 'sessions.checkin.token.write'] })
    );
    expect(both.has('session_staff')).toBe(true);

    const onlyAttendance = desiredRoles(member({ capabilities: ['sessions.attendance.write'] }));
    expect(onlyAttendance.has('session_staff')).toBe(false);

    const onlyToken = desiredRoles(member({ capabilities: ['sessions.checkin.token.write'] }));
    expect(onlyToken.has('session_staff')).toBe(false);
  });

  it('strips everything but linked from a banned member', () => {
    const roles = desiredRoles(
      member({
        isBanned: true,
        isExec: true,
        status: 'competitive',
        membershipType: 'internal',
        permissionRole: 'finance',
        capabilities: ['sessions.attendance.write', 'sessions.checkin.token.write'],
      })
    );
    expect([...roles]).toEqual(['linked']);
  });

  it('gives a pending signup no membership or team role', () => {
    const roles = desiredRoles(member({ status: 'pending_approval', membershipType: 'internal' }));
    expect(roles.has('internal')).toBe(false);
    expect(roles.has('competitive')).toBe(false);
    expect(roles.has('recreation')).toBe(false);
    expect(roles.has('linked')).toBe(true);
  });

  it('gives a suspended member no team role', () => {
    const roles = desiredRoles(member({ status: 'suspended' }));
    expect(roles.has('competitive')).toBe(false);
    expect(roles.has('recreation')).toBe(false);
  });
});

describe('parseGuildRegistry', () => {
  it('returns an empty registry for empty config', () => {
    expect(parseGuildRegistry(undefined).size).toBe(0);
    expect(parseGuildRegistry('').size).toBe(0);
    expect(parseGuildRegistry('   ').size).toBe(0);
  });

  it('parses guilds and their role ids', () => {
    const r = parseGuildRegistry('{"111":{"linked":"9","executives":"8"},"222":{"linked":"7"}}');
    expect(r.size).toBe(2);
    expect(r.get('111')).toEqual({ linked: '9', executives: '8' });
    expect(r.get('222')).toEqual({ linked: '7' });
  });

  it('rejects a role name it does not manage', () => {
    // The point of failing here: a typo'd key that parsed silently would be a
    // role that never syncs and never says why.
    expect(() => parseGuildRegistry('{"111":{"linkd":"9"}}')).toThrow(/unmanaged role/);
  });

  it('refuses to let admin be configured', () => {
    expect(() => parseGuildRegistry('{"111":{"admin":"9"}}')).toThrow(/unmanaged role/);
  });

  it('rejects malformed input', () => {
    expect(() => parseGuildRegistry('not json')).toThrow(/valid JSON/);
    expect(() => parseGuildRegistry('[]')).toThrow(/JSON object/);
    expect(() => parseGuildRegistry('{"111":"nope"}')).toThrow(/must map to an object/);
    expect(() => parseGuildRegistry('{"111":{"linked":123}}')).toThrow(/role id string/);
    expect(() => parseGuildRegistry('{"111":{"linked":""}}')).toThrow(/role id string/);
  });
});

describe('roleDiff', () => {
  const guild = { linked: '1', executives: '2', internal: '3', competitive: '4' };

  it('adds what is missing and removes what is no longer earned', () => {
    const desired = desiredRoles(member({ status: 'competitive', isExec: false }));
    const diff = roleDiff(desired, guild, ['2', '3']);
    expect(diff.add.sort()).toEqual(['1', '4']);
    expect(diff.remove).toEqual(['2']);
  });

  it('is a no-op when Discord already agrees', () => {
    const desired = desiredRoles(member({ status: 'competitive' }));
    const diff = roleDiff(desired, guild, ['1', '3', '4']);
    expect(diff).toEqual({ add: [], remove: [] });
  });

  it('never touches a role the guild has not configured', () => {
    // '99' is Admin, or any unrelated server role. It is not in the map, so it
    // is invisible to the diff rather than protected by a blocklist.
    const desired = desiredRoles(member({ status: 'competitive' }));
    const diff = roleDiff(desired, guild, ['99']);
    expect(diff.remove).not.toContain('99');
    expect(diff.add).not.toContain('99');
  });

  it('strips every managed role when the member is not linked', () => {
    const diff = roleDiff(null, guild, ['1', '2', '3', '4', '99']);
    expect(diff.add).toEqual([]);
    expect(diff.remove.sort()).toEqual(['1', '2', '3', '4']);
    expect(diff.remove).not.toContain('99');
  });

  it('skips a role this guild does not have rather than failing', () => {
    const sparse = { linked: '1' };
    const desired = desiredRoles(member({ isExec: true, status: 'competitive' }));
    const diff = roleDiff(desired, sparse, []);
    expect(diff.add).toEqual(['1']);
  });
});

import { describe, it, expect } from 'vitest';
import {
  desiredRoles,
  membershipFromRoles,
  parseGuildRegistry,
  roleDiff,
  MANAGED_ROLES,
  MEMBERSHIP_ROLES,
  SWEPT_ROLES,
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

  // THE INVERSE OF THE TEST THAT USED TO BE HERE. membership_type no longer
  // decides a Discord role: members pick their own, and the app follows.
  it('asserts no membership role, whatever membership_type says', () => {
    for (const type of MEMBERSHIP_ROLES) {
      const roles = desiredRoles(member({ membershipType: type }));
      for (const role of MEMBERSHIP_ROLES) {
        expect(roles.has(role), `${type} must not assert @${role}`).toBe(false);
      }
    }
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

  it('gives a pending signup no team role', () => {
    const roles = desiredRoles(member({ status: 'pending_approval', membershipType: 'internal' }));
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
    // Holds @Executives (not earned) and @Internal (the member's own).
    const diff = roleDiff(desired, guild, ['2', '3']);
    expect(diff.add.sort()).toEqual(['1', '4']);
    expect(diff.remove).toEqual(['2']);
  });

  it('is a no-op when Discord already agrees', () => {
    const desired = desiredRoles(member({ status: 'competitive' }));
    const diff = roleDiff(desired, guild, ['1', '3', '4']);
    expect(diff).toEqual({ add: [], remove: [] });
  });

  // THE ONE THAT MATTERS MOST IN THIS FILE. Dropping the membership roles from
  // desiredRoles() alone would have made the sweep STRIP them every night —
  // roleDiff removes anything held that is named and not wanted — so the
  // exclusion has to be in the iteration, and this asserts it from both sides.
  it('neither adds nor removes a membership role, in any ordinary state', () => {
    for (const state of [
      member({ status: 'competitive' }),
      member({ status: 'pending_approval' }),
      member({ isBanned: true }),
      member({ isExec: true }),
    ]) {
      const held = roleDiff(desiredRoles(state), guild, ['3']);
      expect(held.remove).not.toContain('3');
      const absent = roleDiff(desiredRoles(state), guild, []);
      expect(absent.add).not.toContain('3');
    }
  });

  // ---- THE ASYMMETRY ----
  //
  // Never added; removed only when the CLUB is withdrawing access rather than
  // the member changing their mind. Member-only channel visibility in this
  // server IS @Internal + @Alumni, so a ban or a tombstone that left them on
  // would leave those channels open to exactly the person just removed from
  // them. reconcile passes revokeMembership for both.

  it('takes a membership role off when the caller is revoking', () => {
    const diff = roleDiff(desiredRoles(member({ isBanned: true })), guild, ['1', '3'], {
      revokeMembership: true,
    });
    expect(diff.remove).toContain('3');
  });

  it('strips a membership role from a tombstone', () => {
    const diff = roleDiff(null, guild, ['3'], { revokeMembership: true });
    expect(diff.remove).toContain('3');
  });

  it('still never ADDS one, even while revoking', () => {
    // There is no branch anywhere that puts a membership role on somebody. The
    // revoking flag is a removal, not a switch back to the old behaviour.
    const diff = roleDiff(desiredRoles(member({ membershipType: 'internal' })), guild, [], {
      revokeMembership: true,
    });
    expect(diff.add).not.toContain('3');
  });

  it('does not remove a membership role the member does not hold', () => {
    const diff = roleDiff(null, guild, ['1'], { revokeMembership: true });
    expect(diff.remove).toEqual(['1']);
  });

  it('never touches a role the guild has not configured', () => {
    // '99' is Admin, or any unrelated server role. It is not in the map, so it
    // is invisible to the diff rather than protected by a blocklist.
    const desired = desiredRoles(member({ status: 'competitive' }));
    const diff = roleDiff(desired, guild, ['99']);
    expect(diff.remove).not.toContain('99');
    expect(diff.add).not.toContain('99');
  });

  it('strips every swept role when the member is not linked', () => {
    const diff = roleDiff(null, guild, ['1', '2', '3', '4', '99']);
    expect(diff.add).toEqual([]);
    // '3' is @Internal, the member's own, and this call is not revoking; '99'
    // is a role the registry does not name at all. Both survive, for different
    // reasons — and '99' survives even when revoking, because a blocklist was
    // never how this works.
    expect(diff.remove.sort()).toEqual(['1', '2', '4']);
    expect(diff.remove).not.toContain('99');
    expect(roleDiff(null, guild, ['99'], { revokeMembership: true }).remove).toEqual([]);
  });

  it('skips a role this guild does not have rather than failing', () => {
    const sparse = { linked: '1' };
    const desired = desiredRoles(member({ isExec: true, status: 'competitive' }));
    const diff = roleDiff(desired, sparse, []);
    expect(diff.add).toEqual(['1']);
  });
});

describe('SWEPT_ROLES', () => {
  it('is every managed role except the three the member picks', () => {
    expect([...SWEPT_ROLES]).toEqual(
      MANAGED_ROLES.filter((r) => !(MEMBERSHIP_ROLES as readonly string[]).includes(r))
    );
    for (const role of MEMBERSHIP_ROLES) {
      // Still MANAGED — the registry has to be able to name it, or the
      // write-back has no way to know which role id means @Alumni.
      expect(MANAGED_ROLES).toContain(role);
      expect(SWEPT_ROLES).not.toContain(role);
    }
  });
});

describe('membershipFromRoles', () => {
  const guild = { linked: '1', internal: '3', alumni: '5', external: '6' };

  it('reads the one membership role the member holds', () => {
    expect(membershipFromRoles(guild, ['1', '3'])).toBe('internal');
    expect(membershipFromRoles(guild, ['5'])).toBe('alumni');
    expect(membershipFromRoles(guild, ['6', '99'])).toBe('external');
  });

  it('answers null when the member has not picked one', () => {
    expect(membershipFromRoles(guild, [])).toBeNull();
    expect(membershipFromRoles(guild, ['1', '99'])).toBeNull();
  });

  it('answers null rather than guessing when two are held', () => {
    // The app can store one membership. Two is a mistake a human can see and
    // fix; picking one here would quietly change somebody's fee tier.
    expect(membershipFromRoles(guild, ['3', '5'])).toBeNull();
  });

  it('answers null for a guild that has not configured the roles', () => {
    expect(membershipFromRoles({ linked: '1' }, ['1', '3', '5'])).toBeNull();
  });
});

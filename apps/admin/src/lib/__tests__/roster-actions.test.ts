import { describe, it, expect } from 'vitest';
import { rosterActionsFor, rosterActionKey, type RosterAction } from '../roster-actions';

const kinds = (actions: RosterAction[]) =>
  actions.map((a) => (a.kind === 'assign' ? `assign:${a.status}` : a.kind));

describe('rosterActionsFor', () => {
  it('offers an inactive account a way back', () => {
    expect(kinds(rosterActionsFor('inactive', {}))).toEqual(['edit', 'restore']);
  });

  it('offers Unban — not Ban — on the suspended tab when they are actually banned', () => {
    expect(kinds(rosterActionsFor('suspended', { is_banned: true }))).toEqual(['edit', 'unban']);
  });

  it('restores rather than unbans a member who was suspended but never banned', () => {
    // The Suspended tab is `status = 'suspended' OR is_banned`. Unbanning here
    // would file a reinstatement_fees row for a ban that never happened.
    expect(kinds(rosterActionsFor('suspended', { is_banned: false }))).toEqual(['edit', 'restore']);
    expect(kinds(rosterActionsFor('suspended', {}))).toEqual(['edit', 'restore']);
  });

  it('sorts a Needs Attention row into a division', () => {
    expect(kinds(rosterActionsFor('attention', {}))).toEqual([
      'edit',
      'assign:recreational',
      'assign:competitive',
    ]);
  });

  it('gives the roster tabs Edit / Ban / Inactive', () => {
    for (const tab of ['competitive', 'recreational']) {
      expect(kinds(rosterActionsFor(tab, {}))).toEqual(['edit', 'ban', 'inactive']);
    }
  });

  it('never offers Inactive to a banned or suspended member', () => {
    // "when a user is suspended please make it so they cannot be marked as
    // inactive, since they may get removed from suspended" — the club owner.
    // A banned member keeps their division, so they are still listed on the
    // roster tabs; is_banned reads to a member as a suspension, so both count.
    for (const tab of ['competitive', 'recreational', '']) {
      expect(kinds(rosterActionsFor(tab, { is_banned: true }))).toEqual(['edit', 'unban']);
      expect(kinds(rosterActionsFor(tab, { status: 'suspended' }))).toEqual(['edit', 'ban']);
    }
  });

  it('never offers Ban to someone already banned', () => {
    // A banned member keeps their status, so they still appear on the roster
    // tabs as well as under Suspended.
    for (const tab of ['competitive', 'recreational', 'suspended']) {
      expect(kinds(rosterActionsFor(tab, { is_banned: true }))).not.toContain('ban');
    }
  });

  it('falls back to the roster actions for an unknown tab', () => {
    expect(kinds(rosterActionsFor('', {}))).toEqual(['edit', 'ban', 'inactive']);
    expect(kinds(rosterActionsFor('nonsense', {}))).toEqual(['edit', 'ban', 'inactive']);
  });

  it('never offers Remove — deactivating is Inactive now, and it is reversible', () => {
    for (const tab of ['competitive', 'recreational', 'attention', 'suspended', 'inactive']) {
      expect(kinds(rosterActionsFor(tab, {}))).not.toContain('delete');
    }
  });

  it('keys every button in a row uniquely', () => {
    for (const tab of ['competitive', 'recreational', 'attention', 'suspended', 'inactive']) {
      const keys = rosterActionsFor(tab, {}).map(rosterActionKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('always starts with Edit', () => {
    for (const tab of ['competitive', 'recreational', 'attention', 'suspended', 'inactive']) {
      expect(rosterActionsFor(tab, {})[0]?.kind).toBe('edit');
      expect(rosterActionsFor(tab, { is_banned: true })[0]?.kind).toBe('edit');
    }
  });

  // Remove wrote { status: 'suspended', active_flag: false } — "Inactive" plus a
  // silent suspension, which then parked the member on the Suspended tab
  // offering to lift a ban that never happened. Every case here previously ran
  // with viewer = {}, so the admin branch that actually rendered the button was
  // untested and it went on appearing on "needs attention", where the owner
  // asked for Edit / Recreational / Competitive only.
  it('never offers Remove, including to an admin', () => {
    for (const tab of ['competitive', 'recreational', 'attention', 'suspended', 'inactive']) {
      for (const player of [{}, { is_banned: true }, { status: 'suspended' }]) {
        const kinds = rosterActionsFor(tab, player, { isAdmin: true }).map((a) => a.kind);
        expect(kinds).not.toContain('remove');
      }
    }
  });

  // The owner specified this tab exactly: Edit / Recreational / Competitive.
  it('offers exactly the three specified actions on "needs attention"', () => {
    expect(rosterActionsFor('attention', {}, { isAdmin: true }).map((a) => a.kind))
      .toEqual(['edit', 'assign', 'assign']);
  });
});

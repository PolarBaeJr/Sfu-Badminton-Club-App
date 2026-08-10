import { describe, it, expect } from 'vitest';
import {
  accessLevelFor,
  atLeast,
  consoleAccessLevelFor,
  hasConsoleAccess,
  isInGoodStanding,
  portfolioOf,
  portfolioPermits,
  PORTFOLIOS,
  type Portfolio,
} from '../access-level';

const ok = { status: 'recreational', is_banned: false, active_flag: true };

describe('accessLevelFor', () => {
  it('resolves the HIGHEST level held', () => {
    expect(accessLevelFor({ role: 'admin', is_exec: true, is_trainer: true })).toBe('admin');
    expect(accessLevelFor({ role: 'player', is_exec: true, is_trainer: true })).toBe('exec');
    expect(accessLevelFor({ role: 'player', is_exec: false, is_trainer: true })).toBe('trainer');
    expect(accessLevelFor({ role: 'player' })).toBeNull();
    expect(accessLevelFor(null)).toBeNull();
  });
});

describe('atLeast', () => {
  it('admits everything above the required rung', () => {
    expect(atLeast('admin', 'trainer')).toBe(true);
    expect(atLeast('exec', 'trainer')).toBe(true);
    expect(atLeast('trainer', 'trainer')).toBe(true);
    expect(atLeast('trainer', 'exec')).toBe(false);
    expect(atLeast(null, 'trainer')).toBe(false);
  });
});

describe('isInGoodStanding', () => {
  it('mirrors admin_access_level() in migration 00057', () => {
    expect(isInGoodStanding(ok)).toBe(true);
    expect(isInGoodStanding({ ...ok, is_banned: true })).toBe(false);
    expect(isInGoodStanding({ ...ok, status: 'suspended' })).toBe(false);
    expect(isInGoodStanding({ ...ok, status: 'pending_approval' })).toBe(false);
    expect(isInGoodStanding({ ...ok, active_flag: false })).toBe(false);
  });

  it('reads missing columns as "fine", the way COALESCE does in SQL', () => {
    // A narrowed select must not lock somebody out by omission.
    expect(isInGoodStanding({ status: 'competitive' })).toBe(true);
  });
});

describe('hasConsoleAccess — the predicate both apps use for the console link', () => {
  it('lets varsity trainers in', () => {
    // The bug this exists to prevent: the settings page tested
    // `is_exec || role === 'admin'` and hid the console link from trainers,
    // while the top bar included them.
    expect(hasConsoleAccess({ ...ok, role: 'player', is_trainer: true })).toBe(true);
    expect(consoleAccessLevelFor({ ...ok, role: 'player', is_trainer: true })).toBe('trainer');
  });

  it('keeps ordinary members out', () => {
    expect(hasConsoleAccess({ ...ok, role: 'player' })).toBe(false);
  });

  it('applies standing BEFORE level, so a banned exec holds nothing', () => {
    expect(hasConsoleAccess({ ...ok, is_exec: true, is_banned: true })).toBe(false);
    expect(consoleAccessLevelFor({ ...ok, is_exec: true, is_banned: true })).toBeNull();
    expect(hasConsoleAccess({ ...ok, role: 'admin', active_flag: false })).toBe(false);
    expect(hasConsoleAccess({ ...ok, is_exec: true, status: 'pending_approval' })).toBe(false);
  });

  it('is false for a missing player row', () => {
    expect(hasConsoleAccess(null)).toBe(false);
    expect(hasConsoleAccess(undefined)).toBe(false);
  });
});

// This is the predicate the SERVER ACTIONS ask — getAuthenticatedExecOrAdmin()
// calls it with the portfolio the action belongs to. The middleware and the nav
// ask canAccess() instead, but a portfolio that narrowed only those would be
// theatre: the actions run on a service-role client that bypasses RLS and can be
// POSTed at directly, so this is the boundary that actually holds.
describe('portfolioPermits — the gate every exec server action sits behind', () => {
  it('lets an exec with no portfolio do everything an exec has always done', () => {
    for (const required of PORTFOLIOS) {
      expect(portfolioPermits('exec', null, required)).toBe(true);
    }
  });

  it('narrows an exec who holds one to their own job', () => {
    expect(portfolioPermits('exec', 'finance', 'finance')).toBe(true);
    expect(portfolioPermits('exec', 'finance', 'tournaments')).toBe(false);
    expect(portfolioPermits('exec', 'finance', 'internal')).toBe(false);
    expect(portfolioPermits('exec', 'finance', 'external')).toBe(false);
    expect(portfolioPermits('exec', 'tournaments', 'finance')).toBe(false);
    expect(portfolioPermits('exec', 'tournaments', 'tournaments')).toBe(true);
  });

  it('leaves admins alone — they are superusers', () => {
    for (const required of PORTFOLIOS) {
      for (const held of PORTFOLIOS) {
        expect(portfolioPermits('admin', held, required)).toBe(true);
      }
    }
  });

  // It answers ONLY the portfolio question. A trainer holds no portfolio, and
  // whether a trainer may run an exec action is the LEVEL's decision, already
  // made by getAuthenticatedAtLeast() before this is ever called.
  it('does not pretend to answer the level question', () => {
    expect(portfolioPermits('trainer', null, 'internal')).toBe(true);
    expect(portfolioPermits(null, null, 'internal')).toBe(true);
  });

  it('refuses everything to an unrecognised portfolio', () => {
    const bogus = 'treasurer' as Portfolio;
    for (const required of PORTFOLIOS) {
      expect(portfolioPermits('exec', bogus, required)).toBe(false);
    }
  });

  // The composition the gate actually performs: read the column off the player
  // row, then ask. A row selected before 00086 was applied has no such column,
  // and it has to mean "not narrowed" — see portfolioOf().
  it('treats a pre-migration player row as unnarrowed', () => {
    const preMigrationExec = { role: 'player', is_exec: true };
    for (const required of PORTFOLIOS) {
      expect(portfolioPermits('exec', portfolioOf(preMigrationExec), required)).toBe(true);
    }
  });
});

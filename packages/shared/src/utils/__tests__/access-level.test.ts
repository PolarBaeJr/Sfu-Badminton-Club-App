import { describe, it, expect } from 'vitest';
import {
  accessLevelFor,
  atLeast,
  consoleAccessLevelFor,
  hasConsoleAccess,
  isInGoodStanding,
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

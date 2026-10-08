import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_CATEGORIES,
  isPushCategoryEnabled,
  isEmailCategoryEnabled,
  normalizeNotificationPreferences,
  normalizeEmailPreferences,
  allEmailCategoriesOff,
  emailCategoryPatch,
  emailPreferenceKey,
  getReminderLeadMinutes,
  DEFAULT_REMINDER_LEAD_MINUTES,
  REMINDER_LEAD_MIN_MINUTES,
  REMINDER_LEAD_MAX_MINUTES,
} from '../notifications';

// The five categories are a contract with the settings UI, the unsubscribe
// route and migration 00058's backfill. Adding one means adding it to 00058 too.
const KEYS = NOTIFICATION_CATEGORIES.map((c) => c.key);

describe('notification categories', () => {
  it('offers the same five categories to push and email', () => {
    expect(KEYS).toEqual(['challenges', 'matches', 'sessions', 'tournaments', 'announcements']);
  });
});

describe('opt-in defaults', () => {
  it('treats an empty blob as everything off, push and email alike', () => {
    for (const key of KEYS) {
      expect(isPushCategoryEnabled({}, key)).toBe(false);
      expect(isEmailCategoryEnabled({}, key)).toBe(false);
    }
    expect(Object.values(normalizeNotificationPreferences({}))).toEqual([
      false, false, false, false, false,
    ]);
    expect(Object.values(normalizeEmailPreferences({}))).toEqual([
      false, false, false, false, false,
    ]);
  });

  it('treats null/undefined/garbage as off rather than on', () => {
    for (const blob of [null, undefined, 'nope', 7]) {
      expect(isPushCategoryEnabled(blob, 'challenges')).toBe(false);
      expect(isEmailCategoryEnabled(blob, 'challenges')).toBe(false);
    }
  });

  it('requires an explicit true — nothing else counts as opted in', () => {
    expect(isPushCategoryEnabled({ challenges: true }, 'challenges')).toBe(true);
    expect(isPushCategoryEnabled({ challenges: false }, 'challenges')).toBe(false);
    expect(isPushCategoryEnabled({ challenges: null }, 'challenges')).toBe(false);
    // Truthy but not `true`: must NOT subscribe anyone.
    expect(isPushCategoryEnabled({ challenges: 'yes' }, 'challenges')).toBe(false);
    expect(isPushCategoryEnabled({ challenges: 1 }, 'challenges')).toBe(false);
  });

  it('keeps push and email on separate keys, so one never implies the other', () => {
    const pushOnly = { challenges: true };
    expect(isPushCategoryEnabled(pushOnly, 'challenges')).toBe(true);
    expect(isEmailCategoryEnabled(pushOnly, 'challenges')).toBe(false);

    const emailOnly = { email_challenges: true };
    expect(isPushCategoryEnabled(emailOnly, 'challenges')).toBe(false);
    expect(isEmailCategoryEnabled(emailOnly, 'challenges')).toBe(true);
  });

  it('reads back exactly what migration 00058 backfills for existing members', () => {
    // What 00058 writes onto every pre-existing row: the previous effective
    // answer, made explicit. Everything must come back ON.
    const backfilled: Record<string, boolean> = {};
    for (const key of KEYS) {
      backfilled[key] = true;
      backfilled[emailPreferenceKey(key)] = true;
    }
    for (const key of KEYS) {
      expect(isPushCategoryEnabled(backfilled, key)).toBe(true);
      expect(isEmailCategoryEnabled(backfilled, key)).toBe(true);
    }
  });

  it('lets a stored unsubscribe survive the backfill it is merged with', () => {
    // 00058 uses `defaults || stored`, so the stored value wins.
    const defaults: Record<string, boolean> = { email_announcements: true };
    const stored: Record<string, boolean> = { email_announcements: false };
    const merged = { ...defaults, ...stored };
    expect(isEmailCategoryEnabled(merged, 'announcements')).toBe(false);
  });
});

describe('email preference keys', () => {
  it('prefixes with email_', () => {
    expect(emailPreferenceKey('sessions')).toBe('email_sessions');
  });

  it('turns every email category off without touching push keys', () => {
    const off = allEmailCategoriesOff();
    expect(Object.keys(off).sort()).toEqual(KEYS.map(emailPreferenceKey).sort());
    for (const key of KEYS) expect(off[emailPreferenceKey(key)]).toBe(false);
  });

  it('patches exactly one category', () => {
    expect(emailCategoryPatch('matches', false)).toEqual({ email_matches: false });
  });
});

describe('reminder lead time', () => {
  it('falls back to the default when unset or unparseable', () => {
    expect(getReminderLeadMinutes({})).toBe(DEFAULT_REMINDER_LEAD_MINUTES);
    expect(getReminderLeadMinutes(null)).toBe(DEFAULT_REMINDER_LEAD_MINUTES);
    expect(getReminderLeadMinutes({ session_reminder_lead_minutes: 'soon' })).toBe(
      DEFAULT_REMINDER_LEAD_MINUTES,
    );
  });

  it('clamps to something actually sendable', () => {
    expect(getReminderLeadMinutes({ session_reminder_lead_minutes: 1 })).toBe(
      REMINDER_LEAD_MIN_MINUTES,
    );
    expect(getReminderLeadMinutes({ session_reminder_lead_minutes: 999999 })).toBe(
      REMINDER_LEAD_MAX_MINUTES,
    );
  });
});

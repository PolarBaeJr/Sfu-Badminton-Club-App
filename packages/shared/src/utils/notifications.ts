// Notification categories drive the per-category PUSH and EMAIL preferences
// shown in player settings and stored on players.notification_preferences
// (JSONB). Categories gate DELIVERY only — the in-app bell always records every
// notification, so nothing is ever silently lost.
//
// OPT-IN. A key is on only when it is stored as exactly `true`; missing, null
// and false all mean off. An empty {} blob therefore means "nothing", which is
// what a brand-new member gets until they choose otherwise.
//
// This was an opt-OUT model until migration 00058. The blob has never carried a
// marker distinguishing "never set" from "explicitly on" — the settings UI only
// ever wrote a key when a toggle was moved — so flipping the default here
// reinterprets every stored-but-absent key and would have unsubscribed every
// existing member in one deploy. 00058 therefore backfills the previous
// effective answer (all categories on) onto every players row that existed at
// the time, letting any explicitly stored value win. Existing members keep
// exactly what they were getting; only rows created afterwards start empty.
//
// The consequence: THIS FILE AND 00058 MUST SHIP TOGETHER. Code without the
// migration silences everyone; the migration without the code is a no-op.

export const NOTIFICATION_CATEGORIES = [
  {
    key: 'challenges',
    label: 'Challenges',
    description: 'When someone challenges you, or accepts, rejects, or cancels a challenge.',
  },
  {
    key: 'matches',
    label: 'Match results',
    description: 'Results to confirm, dispute updates, and rating changes.',
  },
  {
    key: 'sessions',
    label: 'Session reminders',
    description: 'Reminders for sessions you said you are going to.',
  },
  {
    key: 'tournaments',
    label: 'Tournaments',
    description: 'Registration opening, brackets, your matches, and results.',
  },
  {
    key: 'announcements',
    label: 'Announcements',
    description: 'Club-wide announcements from the admins.',
  },
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]['key'];

// True only when the player has explicitly turned this category's push ON.
export function isPushCategoryEnabled(
  preferences: unknown,
  category: NotificationCategory,
): boolean {
  if (!preferences || typeof preferences !== 'object') return false;
  return (preferences as Record<string, unknown>)[category] === true;
}

// Normalize an arbitrary preferences blob to an explicit on/off map over every
// known category — used by the settings UI to render toggles with defaults.
export function normalizeNotificationPreferences(
  preferences: unknown,
): Record<NotificationCategory, boolean> {
  const out = {} as Record<NotificationCategory, boolean>;
  for (const c of NOTIFICATION_CATEGORIES) {
    out[c.key] = isPushCategoryEnabled(preferences, c.key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Email delivery preferences
// ---------------------------------------------------------------------------
// Same categories, same JSONB blob, same opt-in default — but a SEPARATE key
// per category, prefixed `email_`. Push and email are different enough that one
// switch for both is wrong: push is a phone buzzing during a match, email is
// something you read later. Turning off push notifications must not silently
// stop the emails, and vice versa.
//
// Bare keys (`challenges`) stay push-only so existing stored preferences keep
// meaning exactly what they meant before this was added.
const EMAIL_PREFIX = 'email_';

/** The stored key for a category's email preference. */
export function emailPreferenceKey(category: NotificationCategory): string {
  return EMAIL_PREFIX + category;
}

/** True only when the player has explicitly turned this category's EMAIL on. */
export function isEmailCategoryEnabled(
  preferences: unknown,
  category: NotificationCategory,
): boolean {
  if (!preferences || typeof preferences !== 'object') return false;
  return (preferences as Record<string, unknown>)[EMAIL_PREFIX + category] === true;
}

/** The preferences patch that turns one category's email off (or back on). */
export function emailCategoryPatch(
  category: NotificationCategory,
  enabled: boolean,
): Record<string, boolean> {
  return { [EMAIL_PREFIX + category]: enabled };
}

/** Explicit on/off map over every category, for rendering the settings UI. */
export function normalizeEmailPreferences(
  preferences: unknown,
): Record<NotificationCategory, boolean> {
  const out = {} as Record<NotificationCategory, boolean>;
  for (const c of NOTIFICATION_CATEGORIES) {
    out[c.key] = isEmailCategoryEnabled(preferences, c.key);
  }
  return out;
}

/** Turns every category's email off — what "unsubscribe from all" writes. */
export function allEmailCategoriesOff(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const c of NOTIFICATION_CATEGORIES) out[EMAIL_PREFIX + c.key] = false;
  return out;
}

// How far ahead of a session a member wants their reminder — any interval they
// like, stored as minutes in players.notification_preferences beside the
// category toggles, so no new column is needed.
//
// Reminders are per-player rather than per-session because two people RSVP'd to
// the same session can want different notice — which is also why the "already
// reminded" stamp lives on session_rsvp, not on sessions.
//
// Bounded rather than enumerated: under 5 minutes the reminder lands after
// people have already left, and beyond a week it stops being a reminder. Within
// that, it is entirely their call.
export const REMINDER_LEAD_MIN_MINUTES = 5;
export const REMINDER_LEAD_MAX_MINUTES = 7 * 24 * 60; // one week
export const DEFAULT_REMINDER_LEAD_MINUTES = 120;

/** Minutes of notice this player wants, clamped to something sendable. */
export function getReminderLeadMinutes(preferences: unknown): number {
  const raw = (preferences as Record<string, unknown> | null)?.session_reminder_lead_minutes;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_REMINDER_LEAD_MINUTES;
  return Math.min(REMINDER_LEAD_MAX_MINUTES, Math.max(REMINDER_LEAD_MIN_MINUTES, Math.round(n)));
}

/** "2 hours", "45 minutes", "1 day" — for showing the stored value back. */
export function formatReminderLead(minutes: number): string {
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${minutes} minutes`;
}

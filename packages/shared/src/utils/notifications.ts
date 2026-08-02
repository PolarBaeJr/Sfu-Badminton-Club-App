// Notification categories drive the per-type push preferences shown in player
// settings and stored on players.notification_preferences (JSONB). Categories
// gate PUSH delivery only — the in-app bell always records every notification
// so nothing is silently lost. A missing/true entry means the category is on
// (opt-out model), so an empty {} preferences blob keeps every push enabled.

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

// True unless the player has explicitly turned this category's push off.
export function isPushCategoryEnabled(
  preferences: unknown,
  category: NotificationCategory,
): boolean {
  if (!preferences || typeof preferences !== 'object') return true;
  return (preferences as Record<string, unknown>)[category] !== false;
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

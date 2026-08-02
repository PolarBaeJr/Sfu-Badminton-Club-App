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

// How far ahead of a session a member wants their reminder. Stored per player
// in players.notification_preferences alongside the category toggles, so the
// existing settings plumbing carries it with no new column.
//
// Reminders are per-player rather than per-session because two people RSVP'd to
// the same session can want different notice — which is also why the "already
// reminded" stamp lives on session_rsvp, not on sessions.
export const REMINDER_LEAD_OPTIONS = [
  { minutes: 30,  label: '30 minutes before' },
  { minutes: 60,  label: '1 hour before' },
  { minutes: 120, label: '2 hours before' },
  { minutes: 180, label: '3 hours before' },
  { minutes: 1440, label: 'The day before' },
] as const;

export const DEFAULT_REMINDER_LEAD_MINUTES = 120;

/** Minutes of notice this player wants, falling back to the default. */
export function getReminderLeadMinutes(preferences: unknown): number {
  const raw = (preferences as Record<string, unknown> | null)?.session_reminder_lead_minutes;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_REMINDER_LEAD_MINUTES;
  // Only accept values we offer, so a hand-edited preference can't schedule a
  // reminder a month out.
  return REMINDER_LEAD_OPTIONS.some((o) => o.minutes === n) ? n : DEFAULT_REMINDER_LEAD_MINUTES;
}

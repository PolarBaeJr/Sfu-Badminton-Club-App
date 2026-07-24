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

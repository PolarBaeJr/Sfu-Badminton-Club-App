// Derivations behind the /notifications screen.
//
// Lives in apps/player rather than packages/shared for the same reason
// feed-activity.ts does: these are the shapes this one screen needs, and the
// brief for it forbids touching the shared packages.
//
// Everything here is pure and takes `now` as an argument rather than reading
// the clock, so "today" can be tested rather than hoped for.
//
// WHAT THE DATA ACTUALLY CARRIES. A `notifications` row is
// (type, title, body, read_flag, metadata, created_at) — see 00001_schema.sql.
// There is no actor column and no numeric payload anywhere in `metadata`:
// every producer writes only foreign keys (challenge_id, match_id, session_id,
// event_id, tournament_id, announcement_id, walkover_id, flagged_player_id).
// So nothing here tries to name the person a notification is about or to put a
// rating delta beside it — neither is derivable, and guessing would be worse
// than leaving it out.

import { clubDayKey, shiftDayKey } from './feed-activity';

export type NotificationMetadata = Record<string, unknown> | null | undefined;

/** Which token a row's type reads in. Deliberately a small closed set: these
 *  map onto --red / --win / --gold / --mute and nothing else. */
export type NotificationTone = 'red' | 'win' | 'gold' | 'mute';

export interface NotificationAction {
  href: string;
  /** Verb on the affordance. Short enough to sit in a 44px slot at 390px. */
  label: string;
}

/** The whole `notification_type` enum as of 00001_schema.sql, mapped to the
 *  micro-caps label a row leads its detail line with and the tone it reads in.
 *  Eight of these have no producer in the codebase today (result_confirmed,
 *  dispute_opened, dispute_resolved, rank_changed, walkover_confirmed,
 *  opponent_withdrew, tournament_match_ready, tournament_checkin_open) — they
 *  are mapped anyway because rows of those types can already exist in the
 *  table and a screen that only handles what is currently written is a screen
 *  that breaks the day someone wires the rest up. */
const TYPES: Record<string, { label: string; tone: NotificationTone }> = {
  challenge_received: { label: 'Challenge', tone: 'red' },
  challenge_accepted: { label: 'Challenge', tone: 'win' },
  challenge_rejected: { label: 'Challenge', tone: 'mute' },
  challenge_expired: { label: 'Challenge', tone: 'mute' },
  challenge_cancelled: { label: 'Challenge', tone: 'mute' },
  result_pending: { label: 'Result', tone: 'gold' },
  result_confirmed: { label: 'Result', tone: 'win' },
  dispute_opened: { label: 'Dispute', tone: 'red' },
  dispute_resolved: { label: 'Dispute', tone: 'win' },
  rank_changed: { label: 'Rank', tone: 'gold' },
  session_reminder: { label: 'Session', tone: 'mute' },
  walkover_reported: { label: 'Walkover', tone: 'gold' },
  walkover_confirmed: { label: 'Walkover', tone: 'win' },
  opponent_withdrew: { label: 'Walkover', tone: 'mute' },
  admin_alert: { label: 'Alert', tone: 'red' },
  general: { label: 'Update', tone: 'mute' },
  tournament_bracket_published: { label: 'Tournament', tone: 'gold' },
  tournament_match_ready: { label: 'Tournament', tone: 'gold' },
  tournament_match_result: { label: 'Tournament', tone: 'win' },
  tournament_event_completed: { label: 'Tournament', tone: 'win' },
  tournament_checkin_open: { label: 'Tournament', tone: 'red' },
};

/**
 * The micro-caps word a row's detail line leads with.
 *
 * An unrecognised type is turned into something readable rather than dropped:
 * `type` is an enum in Postgres, but the column is read here as a plain string
 * and a future migration adding a value must not blank out the row.
 */
export function notificationLabel(type: string): string {
  const known = TYPES[type];
  if (known) return known.label;
  const humanised = (type ?? '').replace(/_/g, ' ').trim();
  return humanised.length > 0 ? humanised : 'Update';
}

/** Tone for an unrecognised type is 'mute' — neutral, never alarming. */
export function notificationTone(type: string): NotificationTone {
  return TYPES[type]?.tone ?? 'mute';
}

/**
 * The sentence a row leads with.
 *
 * `body` over `title`, because `title` is the category ("New Challenge") and
 * `body` is the sentence with the name in it ("Hannah Kim has challenged
 * you!"). `title` is NOT NULL, so there is always something to show.
 */
export function notificationHeadline(n: { title: string; body?: string | null }): string {
  const body = n.body?.trim();
  return body && body.length > 0 ? body : n.title;
}

function str(metadata: NotificationMetadata, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Where a row's affordance goes, or null when there is nowhere honest to send
 * the member. A button that lands on a 404 — or on a list page that does not
 * mention the thing the notification is about — is worse than no button, so
 * every branch below resolves to a route that exists in apps/player/src/app.
 *
 * `metadata` is expected to have already had `tournament_id` back-filled where
 * only `event_id` was written (see the page) — this function does not query.
 */
export function notificationAction(type: string, metadata: NotificationMetadata): NotificationAction | null {
  const challengeId = str(metadata, 'challenge_id');
  const tournamentId = str(metadata, 'tournament_id');
  const eventId = str(metadata, 'event_id');
  const announcementId = str(metadata, 'announcement_id');
  const sessionId = str(metadata, 'session_id');

  // /challenges/[id] is the one page that shows a challenge, the result
  // submitted against it and any dispute on it — so every challenge-shaped
  // notification lands there.
  const challenge = (label: string): NotificationAction | null =>
    challengeId ? { href: `/challenges/${challengeId}`, label } : null;

  // The event page needs BOTH ids in the route. With only a tournament id the
  // tournament page is still the right, existing destination; with neither
  // there is nothing to link to.
  const event = (label: string): NotificationAction | null => {
    if (tournamentId && eventId) return { href: `/tournaments/${tournamentId}/events/${eventId}`, label };
    if (tournamentId) return { href: `/tournaments/${tournamentId}`, label };
    return null;
  };

  switch (type) {
    case 'challenge_received':
      return challenge('Reply');
    case 'result_pending':
      return challenge('Confirm');
    case 'challenge_accepted':
    case 'challenge_rejected':
    case 'challenge_expired':
    case 'challenge_cancelled':
    case 'result_confirmed':
    case 'dispute_opened':
    case 'dispute_resolved':
    case 'walkover_reported':
    case 'walkover_confirmed':
    case 'opponent_withdrew':
      return challenge('View');

    case 'rank_changed':
      // No per-rank page; /my-stats is where a member's standing lives.
      return { href: '/my-stats', label: 'View' };

    case 'session_reminder':
      // There is no /sessions/[id] route — the list is the destination, and it
      // does show the session being reminded about.
      return { href: '/sessions', label: 'View' };

    case 'tournament_checkin_open':
      return tournamentId && eventId
        ? { href: `/tournaments/${tournamentId}/events/${eventId}/checkin`, label: 'Check in' }
        : { href: '/tournaments/checkin', label: 'Check in' };

    case 'tournament_bracket_published':
    case 'tournament_match_ready':
    case 'tournament_match_result':
    case 'tournament_event_completed':
      return event('View');

    case 'admin_alert':
      // Addressed to the exec and actioned in the admin console. Its metadata
      // is a match / walkover / flagged-player id, none of which the player app
      // has a page for. No button.
      return null;

    case 'general':
      // A carrier type: three unrelated producers use it (announcements,
      // tournament registration, challenge reminders) and only the metadata
      // says which. Read the metadata, not the type.
      if (announcementId) return { href: '/announcements', label: 'Read' };
      if (challengeId) return { href: `/challenges/${challengeId}`, label: 'View' };
      if (tournamentId) return event('View');
      if (sessionId) return { href: '/sessions', label: 'View' };
      return null;

    default:
      // Unrecognised type. The row still renders — headline and detail line —
      // it just gets no affordance, because we do not know where one would go.
      return null;
  }
}

export type NotificationBucket = 'today' | 'week' | 'earlier';

const BUCKET_LABEL: Record<NotificationBucket, string> = {
  today: 'TODAY',
  week: 'EARLIER THIS WEEK',
  earlier: 'EARLIER',
};

/**
 * Which age bucket a notification falls in, in CLUB time.
 *
 * UTC would be wrong here in a way that is invisible in the morning and obvious
 * at night: from about 5pm in Vancouver the UTC date is already tomorrow, so a
 * notification that just arrived would be filed under a day that has not
 * started. clubDayKey/shiftDayKey (shared with the feed river) do the day
 * arithmetic on America/Vancouver calendar keys instead.
 *
 * The buckets are age, not read state — the mockup's first group reads "NEW",
 * but grouping by age while styling by read state means an unread row can sit
 * under yesterday, and calling that group "NEW" would be a lie.
 */
export function notificationBucket(createdAt: string, now: Date, timeZone: string): NotificationBucket {
  const todayKey = clubDayKey(now.toISOString(), timeZone);
  const key = clubDayKey(createdAt, timeZone);
  // `>=` rather than `===` so a row with a clock-skewed future timestamp still
  // lands at the top of the list instead of in "earlier".
  if (key >= todayKey) return 'today';
  if (key >= shiftDayKey(todayKey, -6)) return 'week';
  return 'earlier';
}

export interface NotificationSection<T> {
  key: NotificationBucket;
  label: string;
  items: T[];
}

/**
 * Groups notifications into age buckets, newest first, dropping empty buckets.
 * Sorting is done here rather than assumed so the grouping is correct whatever
 * order the caller's query returned.
 */
export function groupNotificationsByAge<T extends { created_at: string }>(
  items: T[],
  now: Date,
  timeZone: string,
): NotificationSection<T>[] {
  const buckets: Record<NotificationBucket, T[]> = { today: [], week: [], earlier: [] };

  for (const item of [...items].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    buckets[notificationBucket(item.created_at, now, timeZone)].push(item);
  }

  return (['today', 'week', 'earlier'] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: BUCKET_LABEL[key], items: buckets[key] }));
}

/**
 * The header eyebrow. Counting is the caller's job — it must come from an exact
 * COUNT over the whole table, not from the 50 rows this screen fetches, or a
 * member with 60 unread would read "50 UNREAD" here and 60 on the bell.
 */
export function unreadEyebrow(unreadCount: number): string {
  if (unreadCount <= 0) return 'ALL CAUGHT UP';
  return `${unreadCount} UNREAD`;
}

// What Discord actually receives when the club publishes an announcement.
//
// WHY THIS IS IN SHARED AND NOT NEXT TO THE THING THAT SENDS IT. Three places
// have an opinion about the relayed message and they were three separate
// opinions:
//
//   - apps/player/src/app/api/discord/announcements/route.ts decides WHETHER an
//     announcement is relayed at all, and truncates the body;
//   - apps/bot/src/announcements.ts builds the embed — colour, title cap,
//     description cap — and posts it;
//   - the admin console showed neither, so the only way to find out what a post
//     would look like in the channel was to publish it and go and look.
//
// The console's preview is the reason this module exists, and a preview that
// merely RESEMBLES the message is worse than none: it would be believed. So the
// route imports the predicate from here rather than keeping its own copy, and
// the preview and the relay cannot drift on the question of whether something
// is relayed.
//
// THE BOT IS THE ONE PLACE THAT CANNOT IMPORT THIS. apps/bot has zero
// production dependencies on purpose (see apps/bot/package.json) — it is a
// small service holding a Discord token and nothing else. So it keeps its own
// COLORS map, and BOTH SIDES PIN THE SAME LITERALS IN A TEST naming the other
// file. A tripwire on only one side catches a change to that side and misses
// the other, which is exactly how the two Elo weight tables ended up
// disagreeing with nothing failing.

/**
 * announcement_type -> embed colour (00001:618).
 *
 * Mirrors COLORS in apps/bot/src/announcements.ts. Changing a value here
 * without changing it there fails the tripwire test in BOTH packages.
 */
export const ANNOUNCEMENT_EMBED_COLORS: Record<string, number> = {
  info: 0x3498db,
  warning: 0xf1c40f,
  urgent: 0xe74c3c,
  event: 0x2ecc71,
};

/** For a type the bot has never heard of. Mirrors COLOR_DEFAULT. */
export const ANNOUNCEMENT_EMBED_COLOR_DEFAULT = 0x95a5a6;

/** Discord's own limits. */
export const EMBED_TITLE_MAX = 256;
export const EMBED_DESCRIPTION_MAX = 4096;

/**
 * What the relay route trims a body to before the bot ever sees it, which is
 * below Discord's own ceiling on purpose — an embed over 4096 is refused
 * outright, losing the whole announcement rather than its tail.
 */
export const ANNOUNCEMENT_BODY_MAX = 4000;

/**
 * Nothing published longer ago than this is relayed. It is not a display
 * detail: it is the difference between "this will appear in Discord" and
 * "nothing is going to happen", and a preview that ignores it lies in the one
 * case a person is most likely to be confused by — republishing something old.
 */
export const ANNOUNCEMENT_LOOKBACK_HOURS = 72;

/** `#3498db`, for a CSS swatch. */
export function embedColorHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export interface AnnouncementEmbed {
  title: string;
  /** undefined, not '', when the body is empty — an embed may have no description. */
  description: string | undefined;
  color: number;
  url?: string;
}

/**
 * The embed the bot builds, built here so the console can show it.
 *
 * Reproduces embedFor() in apps/bot/src/announcements.ts exactly, including the
 * double trim: the route cuts the body to ANNOUNCEMENT_BODY_MAX and the bot
 * cuts what arrives to EMBED_DESCRIPTION_MAX, so the tighter of the two wins.
 */
export function announcementEmbed(input: {
  title: string;
  body: string;
  type: string;
  url?: string | null;
}): AnnouncementEmbed {
  const description = input.body.slice(0, ANNOUNCEMENT_BODY_MAX).slice(0, EMBED_DESCRIPTION_MAX);
  return {
    title: input.title.slice(0, EMBED_TITLE_MAX),
    description: description || undefined,
    color: ANNOUNCEMENT_EMBED_COLORS[input.type] ?? ANNOUNCEMENT_EMBED_COLOR_DEFAULT,
    ...(input.url ? { url: input.url } : {}),
  };
}

// ---------------------------------------------------------------------------
// Whether it is relayed at all
// ---------------------------------------------------------------------------

/**
 * Why an announcement the club published is not in the channel.
 *
 * `narrow_audience` is a DECISION rather than a fault, and the long note at the
 * top of the relay route is the argument: announcement audiences are per-viewer
 * predicates matched against a member's own row, and a Discord channel is not a
 * viewer. Relaying a competitive-only notice into a channel would assert
 * something about its readers that nothing checks.
 */
export type RelaySkipReason = 'narrow_audience' | 'expired';

export interface RelayVerdict {
  relayable: boolean;
  /** Set only for a PUBLISHED announcement that is nonetheless not relayed. */
  reason: RelaySkipReason | null;
}

/**
 * THE PREDICATE. The relay route calls this; so does the console's preview.
 *
 * Deliberately takes the row's own column names — this is fed straight from a
 * PostgREST row on one side and from a form on the other, and a mapping step
 * between them is a place for the two to disagree.
 */
export function announcementRelayVerdict(
  a: { status: string; target_audience: string; expires_at: string | null },
  now: number
): RelayVerdict {
  const expired = a.expires_at !== null && Date.parse(a.expires_at) <= now;
  const addressedToEveryone = a.target_audience === 'all';
  const published = a.status === 'published';

  if (published && addressedToEveryone && !expired) return { relayable: true, reason: null };

  // A DRAFT GETS NO REASON, because "it is a draft" is not a surprise anybody
  // needs explaining. The reasons exist for the case where somebody published
  // something and nothing appeared.
  if (!published) return { relayable: false, reason: null };
  return { relayable: false, reason: !addressedToEveryone ? 'narrow_audience' : 'expired' };
}

/**
 * What the next relay tick will DO about one announcement.
 *
 * `relayable` on its own is not "this will post", and the gap is where a naive
 * preview lies: an announcement published five days ago and untouched since is
 * outside the lookback window and will never be picked up, however relayable it
 * is. That is `too_old`, and it is the honest answer rather than a promise the
 * next tick will not keep.
 */
export type RelayState =
  /** Not yet in Discord, and the next tick will put it there. */
  | 'posts'
  /** Already in Discord; the text moved, so the message is edited in place. */
  | 'edits'
  /** Already in Discord and unchanged. Nothing happens, and nothing should. */
  | 'in_sync'
  /** In Discord but no longer relayable — the message comes down. */
  | 'retracts'
  /** Not relayable, and there is nothing in Discord to take down. */
  | 'stays_off'
  /** Relayable, not in Discord, and too old for the lookback to reach it. */
  | 'too_old'
  /** Relayable, not in Discord, and the club has configured no channel. */
  | 'no_channel';

export interface RelayStateResult {
  state: RelayState;
  reason: RelaySkipReason | null;
}

export function announcementRelayState(
  a: {
    status: string;
    target_audience: string;
    expires_at: string | null;
    /** The freshness column the relay reads, for the same reason it does. */
    updated_at: string | null;
    title: string;
    body: string;
    type: string;
  },
  context: {
    now: number;
    /** The channel setting, or null when the club has not configured one. */
    channelConfigured: boolean;
    /** The row in discord_announcement_posts, when there is one. */
    posted: { syncedTitle: string; syncedBody: string; syncedType: string } | null;
  }
): RelayStateResult {
  const verdict = announcementRelayVerdict(a, context.now);

  if (!verdict.relayable) {
    return {
      state: context.posted ? 'retracts' : 'stays_off',
      reason: verdict.reason,
    };
  }

  if (context.posted) {
    const body = a.body.slice(0, ANNOUNCEMENT_BODY_MAX);
    const changed =
      context.posted.syncedTitle !== a.title ||
      context.posted.syncedBody !== body ||
      context.posted.syncedType !== a.type;
    // The mapped set is read with no time bound, so an edit is picked up
    // however old the announcement is. Only a FIRST post is time-limited.
    return { state: changed ? 'edits' : 'in_sync', reason: null };
  }

  const since = context.now - ANNOUNCEMENT_LOOKBACK_HOURS * 3600_000;
  if (a.updated_at === null || Date.parse(a.updated_at) < since) {
    return { state: 'too_old', reason: null };
  }

  if (!context.channelConfigured) return { state: 'no_channel', reason: null };

  return { state: 'posts', reason: null };
}

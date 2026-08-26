import {
  clearFeedbackPost,
  fetchFeedbackActions,
  recordFeedbackPost,
  type FeedbackAction,
} from './api.js';
import { loadConfig } from './config.js';
import { DiscordApi } from './discord-api.js';

// Bug reports, club feedback and tournament survey comments, relayed to the
// channels the execs read. See 00173 and the route at
// apps/player/src/app/api/discord/feedback-relay/route.ts, which decides
// everything; this file only carries out what it is told.
//
// ORDER OF OPERATIONS, same as the other three relays and for the same reason:
// call Discord first, record second. A crash in between means a duplicate on
// the next tick, which somebody sees and mentions. Recording first would mean a
// report the relay believes it posted and never did, with nothing to find it by.
//
// The RETRACT path inverts, as always: clearing the mapping before Discord
// would strand a live message with no row pointing at it.

export interface FeedbackRunResult {
  posted: number;
  edited: number;
  retracted: number;
  /** Edits aimed at a message somebody had already deleted by hand. */
  stale: number;
  failed: number;
  skipped: number;
  /** Reports whose screenshot could not be fetched. The words still went out. */
  imagesDropped: number;
}

// Blue for a report, amber for a survey response. Distinct from the match relay
// green and the announcement palette, so a channel carrying more than one of
// them does not read as a single feed.
const COLOR_REPORT = 0x5865f2;
const COLOR_SURVEY = 0xf1c40f;

// THE ONLY HOSTS THIS WILL FETCH FROM.
//
// The bot downloads whatever url the route hands it, and the route stores
// whatever the modal sent. Without this list, anything holding the service
// secret could make the bot issue a GET to an arbitrary address from inside the
// Pi's network and mirror the response into a Discord channel — an SSRF with a
// readback channel. A real screenshot always comes from one of these two.
const ALLOWED_IMAGE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

// Matches the bot's own pick-time cap. Enforced again here because this is the
// side actually spending the memory, and the route is not the only writer of
// image_url in principle.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * The bytes behind a Discord CDN url, or null.
 *
 * NULL IS ORDINARY, not an error path. The url is signed and expires in about a
 * day, so a report that sat unrelayed over a bot outage arrives here with a
 * dead link. Every caller carries on and posts the words without the picture —
 * the alternative is holding the report back forever over an attachment.
 */
export async function fetchImage(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ filename: string; contentType: string; bytes: Uint8Array } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.has(parsed.hostname)) {
    console.error(`[bot] feedback: refusing to fetch a screenshot from ${parsed.hostname}`);
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(parsed.toString(), { signal: controller.signal });
    if (!response.ok) {
      // 403 here is the expired signature, and it is the common case rather
      // than a fault. Logged at log level for exactly that reason.
      console.log(`[bot] feedback: screenshot ${parsed.pathname} -> ${response.status}`);
      return null;
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!contentType.startsWith('image/')) {
      console.error(`[bot] feedback: screenshot is ${contentType || 'untyped'}, not an image`);
      return null;
    }

    // Checked before reading, when the header is there, and again after —
    // content-length is advisory and a missing one is not a reason to buffer
    // without limit.
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES) return null;

    const name = parsed.pathname.split('/').pop() || 'screenshot.png';
    return { filename: name.slice(0, 100), contentType, bytes };
  } catch (error) {
    console.log('[bot] feedback: screenshot fetch failed:', error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const STARS = ['', '★☆☆☆☆', '★★☆☆☆', '★★★☆☆', '★★★★☆', '★★★★★'];

function embedFor(action: FeedbackAction) {
  const isSurvey = action.source === 'event_feedback';

  const fields: { name: string; value: string; inline?: boolean }[] = [];
  if (action.rating !== null && action.rating >= 1 && action.rating <= 5) {
    fields.push({ name: 'Rating', value: `${STARS[action.rating]} (${action.rating}/5)` });
  }
  if (action.author) fields.push({ name: 'From', value: action.author.slice(0, 1024) });

  return {
    // No content field, so nothing outside the embed can carry a mention.
    embeds: [
      {
        title: (action.title || action.context || 'Feedback').slice(0, 256),
        description: action.body.slice(0, 4096),
        color: isSurvey ? COLOR_SURVEY : COLOR_REPORT,
        ...(fields.length ? { fields } : {}),
        footer: { text: action.context.slice(0, 2048) },
        ...(action.createdAt ? { timestamp: action.createdAt } : {}),
      },
    ],
    // BELT AND BRACES WITH THE ATTRIBUTION. `author` is rendered as <@id> so an
    // exec can click through to the reporter, and without this every relayed
    // report would ping them — turning "I filed a quiet bug report" into a
    // notification they get in a room they cannot see.
    allowed_mentions: { parse: [] as string[] },
  };
}

export async function runFeedback(): Promise<FeedbackRunResult> {
  const result: FeedbackRunResult = {
    posted: 0,
    edited: 0,
    retracted: 0,
    stale: 0,
    failed: 0,
    skipped: 0,
    imagesDropped: 0,
  };

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[bot] feedback: DISCORD_BOT_TOKEN is not set');
    return result;
  }

  const { registry } = await loadConfig();
  const api = new DiscordApi({ token });

  for (const guildId of Object.keys(registry)) {
    let actions: FeedbackAction[];
    let skipped: { sourceId: string; reason: string }[];
    let windowCapReached: number | undefined;
    try {
      ({ actions, skipped, windowCapReached } = await fetchFeedbackActions(guildId));
    } catch (error) {
      // One guild's failure must not abort the others.
      console.error(`[bot] feedback: could not read actions for ${guildId}:`, error);
      result.failed += 1;
      continue;
    }

    if (windowCapReached) {
      console.warn(
        `[bot] feedback: ${guildId} filled its ${windowCapReached}-row window; ` +
          'the least recently changed rows wait for the next tick'
      );
    }

    for (const s of skipped) {
      console.log(`[bot] feedback: skipping ${s.sourceId} (${s.reason})`);
    }
    result.skipped += skipped.length;

    for (const action of actions) {
      if (action.kind === 'retract') {
        if (!action.discordMessageId) {
          result.failed += 1;
          continue;
        }
        // DELETE FIRST. A 404 counts as done — somebody removing it by hand has
        // already achieved what this call was for.
        const gone = await api.deleteMessage(action.channelId, action.discordMessageId);
        if (!gone) {
          console.error(
            `[bot] feedback: could not retract ${action.discordMessageId} ` +
              `for ${action.source} ${action.sourceId}`
          );
          result.failed += 1;
          continue;
        }
        try {
          await clearFeedbackPost(action.source, action.sourceId, guildId);
        } catch (error) {
          // The message is gone but the row remains, so the next tick tries the
          // delete again and gets a 404, which it treats as success. Self
          // healing — but loud, because a row that never clears means the write
          // is failing for a reason worth knowing.
          console.error(`[bot] feedback: RETRACTED but not cleared (${action.sourceId}):`, error);
        }
        result.retracted += 1;
        continue;
      }

      const payload = embedFor(action);
      let discordMessageId: string | null = null;
      let stale = false;

      if (action.kind === 'post') {
        // THE SCREENSHOT IS ONLY EVER FETCHED ON A POST. An edit cannot change
        // a message's attachments without re-uploading every one it keeps, and
        // nothing edits a report anyway — the only edited source is a survey
        // response, which never has an image.
        let file = null;
        if (action.imageUrl) {
          file = await fetchImage(action.imageUrl);
          if (!file) result.imagesDropped += 1;
        }

        discordMessageId = await api.postMessageWithFile(action.channelId, payload, file);
        if (!discordMessageId) {
          // NOT recorded: an unposted report stays due and is retried next
          // tick, which is what makes a bot restart a delay rather than a lost
          // report — up to the route's window, after which it is gone for good.
          // That bound is why this must not be recorded on failure.
          result.failed += 1;
          continue;
        }
      } else {
        if (!action.discordMessageId) {
          result.failed += 1;
          continue;
        }
        const outcome = await api.editMessage(action.channelId, action.discordMessageId, payload);
        if (outcome === 'failed') {
          result.failed += 1;
          continue;
        }
        // GONE IS RECORDED, NOT RETRIED. A PATCH cannot resurrect a message
        // somebody deleted by hand, and leaving it unrecorded means re-sending
        // the identical diff every ten minutes until the row falls out of the
        // window. Recording settles the diff instead; the mapping keeps its
        // dead id, which also means it is never re-posted — hand deletion is
        // permanent here, and that is the documented remedy for taking one
        // report down.
        if (outcome === 'gone') {
          stale = true;
          console.warn(
            `[bot] feedback: message ${action.discordMessageId} for ${action.source} ` +
              `${action.sourceId} is gone (deleted by hand?) — recording the edit so it ` +
              'is not retried. It will not be re-posted.'
          );
        }
        discordMessageId = action.discordMessageId;
      }

      try {
        await recordFeedbackPost({
          source: action.source,
          sourceId: action.sourceId,
          guildId,
          channelId: action.channelId,
          discordMessageId,
          summary: action.summary,
        });
      } catch (error) {
        // For a post this is the bad one: the message is in a channel execs
        // read with no row pointing at it, so the next tick posts a SECOND
        // copy. Loud, and named as such.
        console.error(
          `[bot] feedback ${action.kind}ed but NOT recorded ` +
            `(${action.sourceId}/${discordMessageId}) — a duplicate may appear on the ` +
            'next run:',
          error
        );
      }

      if (action.kind === 'post') result.posted += 1;
      else if (stale) result.stale += 1;
      else result.edited += 1;
    }
  }

  return result;
}

import {
  clearMatchPost,
  fetchMatchResultActions,
  recordMatchPost,
  type MatchResultAction,
} from './api.js';
import { loadConfig } from './config.js';
import { DiscordApi } from './discord-api.js';

// Confirmed match results, relayed to a channel. See 00171 and the route at
// apps/player/src/app/api/discord/match-results/route.ts, which decides
// everything; this file only carries out what it is told.
//
// ORDER OF OPERATIONS, same as the other two relays and for the same reason:
// call Discord first, record second. A crash in between means a duplicate on
// the next tick, which somebody sees and mentions. Recording first would mean a
// result the relay believes it posted and never did, with nothing to find it by.
//
// The RETRACT path inverts, as always: clearing the mapping before Discord
// would strand a live message with no row pointing at it.
//
// NO RATING IS RENDERED HERE because none is sent. The route does not select
// rating_delta or post_rating at all, so there is nothing in `action` to leak
// even by accident. Members read their own numbers from /my-stats.

export interface MatchResultRunResult {
  posted: number;
  edited: number;
  retracted: number;
  /** Edits aimed at a message somebody had already deleted by hand. */
  stale: number;
  failed: number;
  skipped: number;
}

// Discord green / red. Deliberately not the announcement palette: a result is
// not a notice, and reusing the colours would make the two read as one feed.
const COLOR_RESULT = 0x2ecc71;

function embedFor(action: MatchResultAction) {
  const winners = action.winner === 'a' ? action.teamA : action.teamB;
  const losers = action.winner === 'a' ? action.teamB : action.teamA;
  const kind = action.matchType === 'doubles' ? 'Doubles' : 'Singles';

  return {
    // No content field, so no mention of any kind can be parsed out of it.
    embeds: [
      {
        title: `${kind} result`.slice(0, 256),
        description: `**${winners}** def. ${losers}`.slice(0, 4096),
        color: COLOR_RESULT,
        ...(action.score ? { fields: [{ name: 'Score', value: action.score }] } : {}),
        ...(action.playedAt ? { timestamp: action.playedAt } : {}),
      },
    ],
    // Belt and braces with the missing content field above: even if a name
    // someday carries an <@id>, Discord parses no mentions out of it.
    allowed_mentions: { parse: [] as string[] },
  };
}

export async function runMatchResults(): Promise<MatchResultRunResult> {
  const result: MatchResultRunResult = {
    posted: 0,
    edited: 0,
    retracted: 0,
    stale: 0,
    failed: 0,
    skipped: 0,
  };

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[bot] match results: DISCORD_BOT_TOKEN is not set');
    return result;
  }

  const { registry } = await loadConfig();
  const api = new DiscordApi({ token });

  for (const guildId of Object.keys(registry)) {
    let actions: MatchResultAction[];
    let skipped: { matchId: string; reason: string }[];
    try {
      ({ actions, skipped } = await fetchMatchResultActions(guildId));
    } catch (error) {
      // One guild's failure must not abort the others.
      console.error(`[bot] match results: could not read actions for ${guildId}:`, error);
      result.failed += 1;
      continue;
    }

    for (const s of skipped) {
      // Logged rather than counted silently, and this relay needs it more than
      // the others: most skips here are DECISIONS (a casual match, a
      // participant opted out of public ranking), not faults, and "we played
      // and it never appeared" has to have an answer that is not a shrug.
      console.log(`[bot] match results: skipping ${s.matchId} (${s.reason})`);
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
            `[bot] match results: could not retract ${action.discordMessageId} ` +
              `for match ${action.matchId}`
          );
          result.failed += 1;
          continue;
        }
        try {
          await clearMatchPost(action.matchId, guildId);
        } catch (error) {
          // The message is gone but the row remains, so the next tick tries the
          // delete again and gets a 404, which it treats as success. Self
          // healing — but loud, because a row that never clears means the write
          // is failing for a reason worth knowing.
          console.error(
            `[bot] match results: RETRACTED but not cleared (${action.matchId}):`,
            error
          );
        }
        result.retracted += 1;
        continue;
      }

      const payload = embedFor(action);
      let discordMessageId: string | null = null;
      let stale = false;

      if (action.kind === 'post') {
        discordMessageId = await api.postMessage(action.channelId, payload);
        if (!discordMessageId) {
          // NOT recorded: an unposted result stays due and is retried next
          // tick, which is what makes a bot restart a delay rather than a lost
          // result — up to the route's 72-hour window, after which it is gone
          // for good. That bound is why this must not be recorded on failure.
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
        // the identical diff every ten minutes until the match falls out of the
        // window. Recording settles the diff instead; the mapping keeps its
        // dead id, which also means the result is never re-posted — hand
        // deletion is permanent here, and that is the documented remedy for
        // taking one result down.
        if (outcome === 'gone') {
          stale = true;
          console.warn(
            `[bot] match results: message ${action.discordMessageId} for match ` +
              `${action.matchId} is gone (deleted by hand?) — recording the edit so it ` +
              'is not retried. It will not be re-posted.'
          );
        }
        discordMessageId = action.discordMessageId;
      }

      try {
        await recordMatchPost({
          matchId: action.matchId,
          guildId,
          channelId: action.channelId,
          discordMessageId,
          summary: action.summary,
        });
      } catch (error) {
        // For a post this is the bad one: the message is in a channel members
        // read with no row pointing at it, so the next tick posts a SECOND
        // copy. Loud, and named as such.
        console.error(
          `[bot] match result ${action.kind}ed but NOT recorded ` +
            `(${action.matchId}/${discordMessageId}) — a duplicate may appear on the ` +
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

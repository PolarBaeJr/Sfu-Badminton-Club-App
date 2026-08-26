import {
  clearAnnouncementPost,
  fetchAnnouncementActions,
  recordAnnouncementPost,
  type AnnouncementAction,
} from './api.js';
import { loadConfig } from './config.js';
import { DiscordApi } from './discord-api.js';

// Relays club announcements into a Discord channel, and keeps them in step: an
// edit on the website edits the message, a retraction deletes it.
//
// ORDER OF OPERATIONS, same as everything else here: post first, record second.
// A crash in between means a duplicate somebody sees and mentions. Recording
// first would mean an announcement the database calls relayed that never was,
// with nothing to find it by.
//
// The RETRACT path inverts, for the reason the tournament sync gives: clearing
// the mapping before Discord would strand the message with nothing pointing at
// it, and nothing would ever take it down.
//
// NOBODY IS MENTIONED. Not @here, not @everyone, not a role — a relayed
// announcement is a channel post, and members who want it follow the channel.
// A feature that could ping the whole server on every publish is one bad
// afternoon away from people muting the channel that carries club notices.
//
// Driven by pg_cron over HTTP rather than a timer, because the compose service
// omits proxy.unscalable — a setInterval here would be one scheduler PER
// REPLICA, all racing to post the same announcement.

export interface AnnouncementRunResult {
  posted: number;
  edited: number;
  retracted: number;
  failed: number;
  skipped: number;
}

// announcement_type -> embed colour (00001:618). Warning and urgent are
// deliberately different: an exec who escalates a notice expects it to LOOK
// escalated, and that is why the mapping table remembers the type at all.
const COLORS: Record<string, number> = {
  info: 0x3498db,
  warning: 0xf1c40f,
  urgent: 0xe74c3c,
  event: 0x2ecc71,
};
const COLOR_DEFAULT = 0x95a5a6;

// Discord refuses an embed whose description runs past 4096 characters. The app
// already trims to 4000; this is the belt to that pair of braces, because the
// value arrives over HTTP and a refused embed loses the whole announcement.
const MAX_DESCRIPTION = 4096;

function embedFor(action: AnnouncementAction) {
  return {
    // No content field, so no mention of any kind can be parsed out of it.
    embeds: [
      {
        title: action.title.slice(0, 256),
        description: action.body.slice(0, MAX_DESCRIPTION) || undefined,
        color: COLORS[action.type] ?? COLOR_DEFAULT,
        ...(action.url ? { url: action.url } : {}),
      },
    ],
    // Belt and braces with the missing content field above: even if a body
    // someday carries an <@id>, Discord parses no mentions out of it.
    allowed_mentions: { parse: [] as string[] },
  };
}

export async function runAnnouncements(): Promise<AnnouncementRunResult> {
  const result: AnnouncementRunResult = {
    posted: 0,
    edited: 0,
    retracted: 0,
    failed: 0,
    skipped: 0,
  };

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[bot] announcements: DISCORD_BOT_TOKEN is not set');
    return result;
  }

  const { registry } = await loadConfig();
  const api = new DiscordApi({ token });

  for (const guildId of Object.keys(registry)) {
    let actions: AnnouncementAction[];
    let skipped: { announcementId: string; reason: string }[];
    try {
      ({ actions, skipped } = await fetchAnnouncementActions(guildId));
    } catch (error) {
      // One guild's failure must not abort the others.
      console.error(`[bot] announcements: could not read actions for ${guildId}:`, error);
      result.failed += 1;
      continue;
    }

    for (const s of skipped) {
      // Logged rather than counted silently. "I published it and nothing
      // appeared in Discord" has to have an answer, and for narrow_audience the
      // answer is a decision rather than a fault.
      console.log(`[bot] announcements: skipping ${s.announcementId} (${s.reason})`);
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
            `[bot] announcements: could not retract ${action.discordMessageId} ` +
              `for ${action.announcementId}`
          );
          result.failed += 1;
          continue;
        }
        try {
          await clearAnnouncementPost(action.announcementId, guildId);
        } catch (error) {
          // The message is gone but the row remains, so the next tick tries the
          // delete again and gets a 404, which it treats as success. Self
          // healing — but loud, because a row that never clears means the write
          // is failing for a reason worth knowing.
          console.error(
            `[bot] announcements: RETRACTED but not cleared (${action.announcementId}):`,
            error
          );
        }
        result.retracted += 1;
        continue;
      }

      const payload = embedFor(action);
      let discordMessageId: string | null = null;

      if (action.kind === 'post') {
        discordMessageId = await api.postMessage(action.channelId, payload);
        if (!discordMessageId) {
          // NOT recorded: an unposted announcement stays due and is retried on
          // the next tick, which is what makes a bot restart a delay rather
          // than a silently dropped club notice.
          result.failed += 1;
          continue;
        }
      } else {
        if (!action.discordMessageId) {
          result.failed += 1;
          continue;
        }
        const ok = await api.editMessage(action.channelId, action.discordMessageId, payload);
        if (!ok) {
          result.failed += 1;
          continue;
        }
        discordMessageId = action.discordMessageId;
      }

      try {
        await recordAnnouncementPost({
          announcementId: action.announcementId,
          guildId,
          channelId: action.channelId,
          discordMessageId,
          title: action.title,
          body: action.body,
          type: action.type,
        });
      } catch (error) {
        // For a post this is the bad one, and worse than the tournament
        // equivalent: the message exists in a channel members read with no row
        // pointing at it, so the next tick posts a SECOND copy of the same club
        // announcement. Loud, and named as such.
        console.error(
          `[bot] announcement ${action.kind}ed but NOT recorded ` +
            `(${action.announcementId}/${discordMessageId}) — a duplicate may appear ` +
            'on the next run:',
          error
        );
      }

      if (action.kind === 'post') result.posted += 1;
      else result.edited += 1;
    }
  }

  return result;
}

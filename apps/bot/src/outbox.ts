import { claimOutboxMessages, recordOutboxResult, type OutboxMessage } from './api.js';
import { postAuditEntry } from './audit.js';
import { loadConfig } from './config.js';
import { DiscordApi } from './discord-api.js';

// Posting the messages the admin console asked for (00222).
//
// THE CONSOLE'S HALF OF /say. An exec writing announcements in the console had
// to leave it, open Discord and run a slash command to put one line in the
// channel. This is the same act from the same place.
//
// IT RIDES THE ANNOUNCEMENTS TICK rather than getting a cron job of its own.
// pg_cron already calls POST /announcements every five minutes, and adding a
// second job would need an owner to run SQL on production — a step that would
// sit undone while the feature looked shipped. The cost is that Send means
// "within five minutes", which is why the console shows the row's state instead
// of a toast that claims it has already gone.
//
// ORDER OF OPERATIONS, the same as every other relay here: POST FIRST, RECORD
// SECOND. A crash in between leaves the row claimed, and the claim expires
// after ten minutes, so the worst case is a duplicate somebody mentions rather
// than a club message that silently never went out.
//
// AND IT WRITES THE SAME AUDIT ENTRY /say DOES. That is not decoration: /say's
// own argument is that a bot which can speak for the club with no record of who
// moved its mouth is the thing worth not building, and a console that could do
// it silently would be the back door around that argument. The row in
// audit_logs is not enough on its own — an exec reading the Discord audit
// channel would see club messages appear from nowhere.

export interface OutboxRunResult {
  sent: number;
  failed: number;
}

/** Mirrors ANNOUNCEMENT_EMBED_COLORS in @badminton/shared — see announcements.ts. */
const COLORS: Record<string, number> = {
  info: 0x3498db,
  warning: 0xf1c40f,
  urgent: 0xe74c3c,
  event: 0x2ecc71,
};
const COLOR_DEFAULT = 0x95a5a6;

function payloadFor(message: OutboxMessage) {
  // THE DEFAULT IS SILENCE, and it is the same argument /say makes. An empty
  // `parse` turns every @here, @everyone and @role in the text into plain text
  // — they still READ as mentions and they notify nobody. A ping that nobody
  // asked for has already buzzed every phone in the server, and there is no way
  // to take that back.
  const allowed_mentions = message.ping
    ? { parse: ['users', 'roles', 'everyone'] }
    : { parse: [] as string[] };

  if (message.embed) {
    return {
      // No content field, so there is nothing for Discord to parse a mention
      // out of even before allowed_mentions is considered.
      embeds: [
        {
          title: message.embed.title.slice(0, 256),
          description: message.embed.body.slice(0, 4096) || undefined,
          color: COLORS[message.embed.type] ?? COLOR_DEFAULT,
        },
      ],
      allowed_mentions,
    };
  }

  return { content: message.content ?? '', allowed_mentions };
}

/**
 * What the audit entry quotes.
 *
 * An embed is two fields and the entry has to read as one message, so the title
 * leads and the body follows. Not truncated here — postAuditEntry's own quoting
 * caps it and SAYS it capped it, which is the behaviour /say already relies on.
 */
function auditBody(message: OutboxMessage): string {
  if (message.embed) {
    return message.embed.body
      ? `**${message.embed.title}**\n${message.embed.body}`
      : `**${message.embed.title}**`;
  }
  return message.content ?? '';
}

export async function runOutbox(): Promise<OutboxRunResult> {
  const result: OutboxRunResult = { sent: 0, failed: 0 };

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[bot] outbox: DISCORD_BOT_TOKEN is not set');
    return result;
  }

  const { registry, auditChannelId } = await loadConfig();
  const api = new DiscordApi({ token });

  for (const guildId of registry.keys()) {
    let messages: OutboxMessage[];
    try {
      ({ messages } = await claimOutboxMessages(guildId));
    } catch (error) {
      // One guild's failure must not abort the others, and a claim that never
      // happened costs nothing — the rows are still pending.
      console.error(`[bot] outbox: could not claim for ${guildId}:`, error);
      result.failed += 1;
      continue;
    }

    for (const message of messages) {
      const discordMessageId = await api.postMessage(message.channelId, payloadFor(message));

      if (!discordMessageId) {
        result.failed += 1;
        try {
          // The row goes back into the pool with one attempt spent. Three
          // strikes and it stops, with the reason readable in the console —
          // which is the only thing that gets a missing permission fixed.
          await recordOutboxResult({
            id: message.id,
            error:
              `Discord refused the message (attempt ${message.attempts + 1}). ` +
              'Check the bot can post in that channel.',
          });
        } catch (error) {
          console.error(`[bot] outbox: could not record the failure of ${message.id}:`, error);
        }
        continue;
      }

      result.sent += 1;

      // BEFORE the write-back, and deliberately: if this process is about to
      // die, the entry naming who spoke is worth more than the row that closes
      // the send. The duplicate that a lost write-back can cause is visible;
      // an unattributed club message is not.
      try {
        await postAuditEntry(api, auditChannelId, {
          kind: 'console_message',
          requestedBy: message.requestedBy,
          guildId,
          channelId: message.channelId,
          messageId: discordMessageId,
          body: auditBody(message),
          pinged: message.ping,
        });
      } catch (error) {
        // The message is already posted. Failing to record it must not turn a
        // good send into a failed one.
        console.error(`[bot] outbox: could not write the audit entry for ${message.id}:`, error);
      }

      try {
        await recordOutboxResult({ id: message.id, discordMessageId });
      } catch (error) {
        // LOUD, and the worst case in this file: the message is in a channel
        // members read, the row is still claimed, and in ten minutes it becomes
        // claimable again — so the next tick posts a SECOND copy of something
        // the club said out loud.
        console.error(
          `[bot] outbox: SENT but not recorded (${message.id}/${discordMessageId}) — ` +
            'a duplicate may appear in ten minutes:',
          error
        );
      }
    }
  }

  return result;
}

import { claimOutboxMessages, recordOutboxResult, type OutboxMessage } from './api.js';
import { postAuditEntry } from './audit.js';
import { componentsForButtonSet } from './commands.js';
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

/** The mentions the console already resolved, taken back out of the text. */
const ROLE_MENTION = /<@&(\d+)>/g;

/**
 * The roles a ping line is allowed to notify, read from the line itself.
 *
 * DERIVED FROM THE TEXT RATHER THAN CARRIED BESIDE IT, which is what makes it
 * impossible for the words and the notification to disagree: the console
 * resolves a picked role name to `<@&id>` before it writes the row, so the only
 * roles in this list are the ones a reader can see named.
 *
 * Discord caps `allowed_mentions.roles` at 100, and going over is a 400 rather
 * than a truncation, so the slice is the difference between nine mentions and a
 * refused message.
 */
function roleIdsIn(text: string): string[] {
  ROLE_MENTION.lastIndex = 0;
  const ids = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = ROLE_MENTION.exec(text)) !== null) ids.add(match[1]!);
  return [...ids].slice(0, 100);
}

/**
 * What one row sends to Discord.
 *
 * `withComponents: false` is the FALLBACK's half of the signature, not an
 * option a caller picks: it builds the same message without its buttons, for
 * the one retry runOutbox allows itself when Discord refuses the first attempt.
 */
function payloadFor(message: OutboxMessage, options?: { withComponents?: boolean }) {
  // THE BUTTONS, RESOLVED FROM A NAME the row carries (00227). `components` is
  // spread into the returns below and NOT written as a key set to null, so a row
  // with no button set produces the identical payload it produced before this
  // existed, byte for byte. That is the property the outbox tests pin with
  // `toEqual`, and every message the club has ever queued goes down it.
  const components =
    options?.withComponents === false ? null : componentsForButtonSet(message.buttonSet);

  // THE DEFAULT IS SILENCE, and it is the same argument /say makes. An empty
  // `parse` turns every @here, @everyone and @role in the text into plain text
  // — they still READ as mentions and they notify nobody. A ping that nobody
  // asked for has already buzzed every phone in the server, and there is no way
  // to take that back.
  const allowed_mentions = message.ping
    ? { parse: ['users', 'roles', 'everyone'] }
    : { parse: [] as string[] };

  // A PING LINE AND AN EMBED, IN ONE MESSAGE, and it must be tested before the
  // embed-only branch below or it would never be reached.
  //
  // This is the only shape that can both look like a notice and reach a phone.
  // `content` renders ABOVE the embed and is the only field Discord notifies
  // from: a mention inside embed text never rings anybody, whatever
  // allowed_mentions says. There is no way to put content below an embed and no
  // second message involved.
  if (message.embed && message.content) {
    return {
      content: message.content,
      embeds: [
        {
          title: message.embed.title.slice(0, 256),
          description: message.embed.body.slice(0, 4096) || undefined,
          color: COLORS[message.embed.type] ?? COLOR_DEFAULT,
        },
      ],
      // NAMED ROLES AND NOTHING ELSE, never `parse: ['everyone']`. An explicit
      // `roles` array beside a non-empty `parse` is a Discord API error, and an
      // empty `parse` is what makes an `@everyone` typed anywhere in this line
      // incapable of ringing: it renders, and it reaches nobody.
      allowed_mentions: message.ping
        ? { parse: [] as string[], roles: roleIdsIn(message.content) }
        : { parse: [] as string[] },
      ...(components ? { components } : {}),
    };
  }

  if (message.embed) {
    return {
      // No content field IN THIS SHAPE, so there is nothing for Discord to
      // parse a mention out of even before allowed_mentions is considered. It
      // is not a statement about embeds in general any more: the branch above
      // gives one a line that does notify, and it is the only way to.
      embeds: [
        {
          title: message.embed.title.slice(0, 256),
          description: message.embed.body.slice(0, 4096) || undefined,
          color: COLORS[message.embed.type] ?? COLOR_DEFAULT,
        },
      ],
      allowed_mentions,
      ...(components ? { components } : {}),
    };
  }

  return {
    content: message.content ?? '',
    allowed_mentions,
    ...(components ? { components } : {}),
  };
}

/**
 * What the audit entry quotes.
 *
 * An embed is two fields and the entry has to read as one message, so the title
 * leads and the body follows. Not truncated here — postAuditEntry's own quoting
 * caps it and SAYS it capped it, which is the behaviour /say already relies on.
 *
 * THE BUTTONS ARE NOT QUOTED, and that is deliberate: the Discord audit entry
 * records what the club SAID, and three fixed buttons that answer the clicker
 * privately are not words anybody said. The admin audit_logs entry does record
 * the set, because there the question is what an exec asked for.
 */
function auditBody(message: OutboxMessage): string {
  if (message.embed) {
    return message.embed.body
      ? `**${message.embed.title}**\n${message.embed.body}`
      : `**${message.embed.title}**`;
  }
  return message.content ?? '';
}

/**
 * What the console is told when the words went out and the buttons did not.
 *
 * WRITTEN FOR AN EXEC, not for a log. It lands in `last_error`, which the recent
 * list already renders in red under the row, so the person who pressed Send
 * learns the one thing they would otherwise have to spot in the channel by eye.
 * Under the column's 500-character CHECK with room to spare.
 */
const BUTTONS_REFUSED_NOTE =
  'Posted, but Discord would not take the buttons, so the message went out without them. ' +
  'The words are in the channel.';

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
      // AN EDIT IS A PATCH OF THE MESSAGE ALREADY IN THE CHANNEL, never a
      // second copy of it. A row that carries a Discord message id has been
      // posted once and re-queued by the console with new words, so posting
      // here would leave the club saying the same thing twice, the wrong
      // version first.
      //
      // A MESSAGE SOMEBODY DELETED BY HAND IS REFUSED AND SAID SO, not
      // reposted. 'gone' is a 404 on the PATCH, which means an exec removed the
      // message on purpose; silently putting it back is the worst thing this
      // file could do. It is recorded as a failure, so the attempt budget
      // retires the row rather than retrying it forever.
      //
      // AND THE WORDS COME FIRST IF DISCORD REFUSES THE BUTTONS. Nothing has
      // ever proved in production that a bot-POSTED message here is accepted
      // with components: the session board has never posted one, because
      // `session_board_channel_id` is still unset. So a refusal is retried ONCE
      // without them rather than losing a club message to an untested field, and
      // the console is told it happened.
      let discordMessageId: string | null;
      let refusal: string | null = null;
      const withButtons = componentsForButtonSet(message.buttonSet) !== null;
      let note: string | null = null;
      if (message.discordMessageId) {
        let outcome = await api.editMessage(
          message.channelId,
          message.discordMessageId,
          payloadFor(message)
        );
        // RETRYING A PATCH IS SAFE, which is what separates this from the post
        // path below: an edit cannot create a second message however many times
        // it is attempted. 'gone' is never retried, because it is the one answer
        // that means somebody deleted the message on purpose.
        if (outcome === 'failed' && withButtons) {
          outcome = await api.editMessage(
            message.channelId,
            message.discordMessageId,
            payloadFor(message, { withComponents: false })
          );
          if (outcome === 'ok') note = BUTTONS_REFUSED_NOTE;
        }
        discordMessageId = outcome === 'ok' ? message.discordMessageId : null;
        if (outcome === 'gone') {
          refusal = 'That message is gone from Discord, so there was nothing to edit.';
        }
      } else if (withButtons) {
        // postMessageResult RATHER THAN postMessage, for the one distinction
        // that decides whether a retry is allowed at all. postMessage folds
        // every failure into null, and null cannot be retried safely.
        const outcome = await api.postMessageResult(message.channelId, payloadFor(message));
        if (typeof outcome === 'object') {
          discordMessageId = outcome.id;
        } else if (outcome === 'refused') {
          // 4xx ONLY, SO NOTHING WAS CREATED, and that is the whole licence for
          // this retry.
          const retry = await api.postMessageResult(
            message.channelId,
            payloadFor(message, { withComponents: false })
          );
          discordMessageId = typeof retry === 'object' ? retry.id : null;
          if (discordMessageId) note = BUTTONS_REFUSED_NOTE;
        } else {
          // 'unknown' IS NEVER RETRIED. A 5xx or a thrown fetch may have landed
          // the message with nothing here able to find it again, and retrying
          // that is how the club says the same thing twice in a channel every
          // member reads. It falls through to the failure recording below, which
          // spends an attempt and hands the row to the next tick.
          discordMessageId = null;
        }
      } else {
        discordMessageId = await api.postMessage(message.channelId, payloadFor(message));
      }

      if (!discordMessageId) {
        result.failed += 1;
        try {
          // The row goes back into the pool with one attempt spent. Three
          // strikes and it stops, with the reason readable in the console —
          // which is the only thing that gets a missing permission fixed.
          await recordOutboxResult({
            id: message.id,
            error:
              refusal ??
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
        // THE NOTE IS SPREAD IN RATHER THAN PASSED AS NULL, so the ordinary
        // send is the same two-field call it always was.
        await recordOutboxResult({
          id: message.id,
          discordMessageId,
          ...(note ? { note } : {}),
        });
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

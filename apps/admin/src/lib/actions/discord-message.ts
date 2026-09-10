'use server';

import {
  ANNOUNCEMENT_EMBED_COLORS,
  EMBED_DESCRIPTION_MAX,
  EMBED_TITLE_MAX,
  ExpectedError,
} from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { resolveRoleMentions } from '../discord-mentions';
import { revalidatePath } from 'next/cache';
import { requireCapability } from './_shared';

// Speaking as the club in Discord, from the console.
//
// THE CONSOLE HOLDS NO DISCORD TOKEN, and it must not. The bot is a small
// service whose whole justification is that the token lives in exactly one
// place with nothing else beside it — apps/bot has zero production
// dependencies for the same reason. Giving this app a DISCORD_BOT_TOKEN would
// double the number of internet-facing web apps that can speak as the club.
//
// So this writes a row and the bot posts it (00222): THE APP DECIDES, THE BOT
// POSTS, which is the split every other part of this integration already uses.
// The cost is that Send means "within five minutes" — the bot drains the outbox
// on the announcements tick — and the panel that calls this says so and shows
// the row's state afterwards, rather than a toast claiming more than it knows.

/** Discord's own cap on a plain message. Enforced in the DB too (00222). */
const CONTENT_MAX = 2000;

export interface QueueDiscordMessageInput {
  /** A plain message, exactly like /say. Mutually exclusive with the embed. */
  content?: string;
  /** An embed, exactly like a relayed announcement. */
  embed?: { title: string; body: string; type: 'info' | 'warning' | 'urgent' | 'event' };
  /**
   * Where. Omitted means the channel the club configured for announcements,
   * which is the only channel this app knows the name of.
   */
  channelId?: string;
  /**
   * WHETHER MENTIONS NOTIFY, and the default is silence.
   *
   * With it off, an @everyone typed into the text still READS as a mention and
   * buzzes nobody — the posture /say has and for the same reason: a ping
   * nobody asked for has already reached every phone in the server and cannot
   * be recalled.
   */
  ping?: boolean;
}

/** A Discord snowflake, and nothing else. Mirrors the CHECK in 00222. */
function assertChannelId(value: string): string {
  const trimmed = value.trim();
  if (!/^[0-9]{5,25}$/.test(trimmed)) {
    throw new ExpectedError(
      'That does not look like a Discord channel ID. Turn on Developer Mode in Discord, ' +
        'right-click the channel and choose Copy Channel ID.',
    );
  }
  return trimmed;
}

/**
 * Queue one message for the bot to post.
 *
 * EVERY EXPORTED PARAMETER HERE IS A CLIENT-CONTROLLED POST FIELD — a server
 * action is an HTTP endpoint, and nothing stops a caller sending a shape the UI
 * never offers. So `channelId` is validated rather than trusted, `ping` is a
 * boolean coerced from whatever arrived, and the content/embed choice is
 * settled here AND by a CHECK constraint in the table.
 */
export async function queueDiscordMessage(input: QueueDiscordMessageInput) {
  const admin = await requireCapability('announcements.discord.write');
  const adminClient = createAdminClient();

  const content = typeof input.content === 'string' ? input.content.trim() : '';
  const embedTitle = input.embed ? input.embed.title.trim() : '';
  const embedBody = input.embed ? input.embed.body.trim() : '';

  if (content && embedTitle) {
    throw new ExpectedError('Send a message or an embed, not both.');
  }
  if (!content && !embedTitle) {
    throw new ExpectedError('There was nothing to send.');
  }
  if (content.length > CONTENT_MAX) {
    throw new ExpectedError(`Discord refuses a message over ${CONTENT_MAX} characters.`);
  }
  if (embedTitle.length > EMBED_TITLE_MAX) {
    throw new ExpectedError(`An embed headline stops at ${EMBED_TITLE_MAX} characters.`);
  }
  if (embedBody.length > EMBED_DESCRIPTION_MAX) {
    throw new ExpectedError(`An embed body stops at ${EMBED_DESCRIPTION_MAX} characters.`);
  }
  // AN EMBED'S TEXT IS NEVER RESOLVED INTO MENTIONS, deliberately, and this is
  // the branch where that decision belongs. `payloadFor` (apps/bot/src/outbox.ts)
  // builds the embed shape with NO content field, and Discord does not notify
  // anybody from embed text however `allowed_mentions` is set. Rewriting a role
  // name in here would render a mention chip that can never ring a phone, which
  // makes the composer's own switch ("WILL buzz every phone it names") a false
  // statement for this shape. A mention that cannot ping is worse than a name.
  if (input.embed && !(input.embed.type in ANNOUNCEMENT_EMBED_COLORS)) {
    throw new ExpectedError('That is not one of the four announcement categories.');
  }

  // WHICH SERVER. The club runs one, and the registry is the list the bot
  // sweeps — a guild absent from it is a server the bot was never configured
  // for, and queueing into it would produce a message nothing ever posts.
  const { data: guilds, error: guildError } = await adminClient
    .from('discord_guilds')
    .select('guild_id')
    .order('guild_id');

  if (guildError) throw new Error(guildError.message);
  const guildId = (guilds ?? [])[0]?.guild_id as string | undefined;
  if (!guildId) {
    throw new ExpectedError(
      'No Discord server is registered yet. Run /setup in the server first.',
    );
  }

  // ROLE NAMES BECOME REAL MENTIONS, AND THIS IS THE ONLY PLACE IT HAPPENS.
  //
  // It sits here because it needs the guild id, and above the channel work
  // because a message that is about to be refused for length should not first
  // cost a settings read. The `@` guard means a message with no `@` in it pays
  // nothing for any of this: the rest of this feature counts its round trips
  // carefully and this is not the place to stop counting. An embed takes the
  // same free ride without needing a second condition, since `content` is the
  // empty string for that shape.
  //
  // A FAILED READ THROWS RATHER THAN DEGRADING. The whole point of a message
  // like this is the ping, and quietly posting the literal text `@internal`
  // where a mention was meant is the exact failure this exists to remove.
  let outgoing = content;
  let mentionedRoles: string[] = [];
  if (content.includes('@')) {
    const { data: roles, error: rolesError } = await adminClient
      .from('discord_guild_roles')
      .select('role_name, role_id')
      .eq('guild_id', guildId);

    if (rolesError) {
      throw new ExpectedError(
        'Could not read the club\'s Discord roles, so a role name in this message would have ' +
          'posted as plain text instead of a mention. Nothing was queued. Try again.',
      );
    }

    const resolved = resolveRoleMentions(
      content,
      (roles ?? []) as { role_name: string; role_id: string }[],
    );
    outgoing = resolved.text;
    mentionedRoles = resolved.matched;
  }

  // THE SECOND LENGTH CHECK, because resolution only ever makes the text longer.
  // The typed-length check above is the one the writer can act on; this one
  // catches what expansion added. `discord_outbox` has a CHECK of its own on
  // 2000 characters (00222), so without this a 1995-character message with a
  // mention in it comes back as a raw Postgres constraint string.
  if (outgoing.length > CONTENT_MAX) {
    throw new ExpectedError(
      `Turning the role names in this message into real mentions takes it to ${outgoing.length} ` +
        `characters, and Discord refuses anything over ${CONTENT_MAX}. Each @role becomes an id, ` +
        'which costs about 22 characters. Cut roughly ' +
        `${outgoing.length - CONTENT_MAX} characters and send it again.`,
    );
  }

  // The configured announcements channel is the default because it is the only
  // channel this app has ever been told about. Anything else has to be pasted,
  // and is checked rather than trusted.
  let channelId: string;
  if (input.channelId) {
    channelId = assertChannelId(input.channelId);
  } else {
    const { data: setting } = await adminClient
      .from('discord_settings')
      .select('value')
      .eq('key', 'announcement_channel_id')
      .maybeSingle();
    const configured = (setting?.value as string | null)?.trim();
    if (!configured) {
      throw new ExpectedError(
        'No announcements channel is configured, so there is nowhere to send this. ' +
          'Set one with /config in Discord, or paste a channel ID.',
      );
    }
    channelId = assertChannelId(configured);
  }

  const ping = input.ping === true;

  const { data: row, error } = await adminClient
    .from('discord_outbox')
    .insert({
      guild_id: guildId,
      channel_id: channelId,
      content: outgoing || null,
      embed_title: embedTitle || null,
      embed_body: content ? null : embedBody || null,
      embed_type: content ? null : (input.embed?.type ?? null),
      ping,
      requested_by: admin.id,
    })
    .select('id, created_at')
    .single();

  if (error) throw new Error(error.message);

  // QUOTING THE MESSAGE, for the reason /say's audit entry gives: a message
  // somebody later deletes in Discord is still readable here, and a bot that
  // can speak for the club with no record of who moved its mouth is the thing
  // worth not building. The ping bit is in there because it is the difference
  // between a line in a channel and every phone in the server buzzing.
  //
  // IT QUOTES THE RESOLVED TEXT, not what was typed. `target_id` is the outbox
  // row, and an entry quoting something other than that row's content is a trail
  // that disagrees with the thing it points at. `mentioned_roles` restores what
  // the raw text was good for, which is that a human can read "internal" where
  // the row now holds `<@&1234...>`, and it names the interesting fact plainly:
  // this ping was aimed at a specific role. Neither costs a second copy of the
  // message.
  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'discord_message_queued',
    target_type: 'discord_outbox',
    target_id: row.id,
    new_value: {
      channel_id: channelId,
      ping,
      ...(content ? { content: outgoing } : { embed_title: embedTitle, embed_body: embedBody }),
      ...(mentionedRoles.length ? { mentioned_roles: mentionedRoles } : {}),
    },
  });

  revalidatePath('/announcements');
  return row;
}

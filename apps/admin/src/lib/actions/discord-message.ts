'use server';

import {
  ANNOUNCEMENT_EMBED_COLORS,
  EMBED_DESCRIPTION_MAX,
  EMBED_TITLE_MAX,
  ExpectedError,
} from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { resolveRoleMentions, resolveRoleNames } from '../discord-mentions';
import { readOutboxRows, type OutboxRow } from '../discord-outbox';
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

/** The admin client, named once so the helpers below can be typed. */
type AdminClient = ReturnType<typeof createAdminClient>;

export interface QueueDiscordMessageInput {
  /** A plain message, exactly like /say. */
  content?: string;
  /** An embed, exactly like a relayed announcement. */
  embed?: { title: string; body: string; type: 'info' | 'warning' | 'urgent' | 'event' };
  /**
   * Where. Omitted means the channel the club configured for announcements,
   * which is the only channel this app knows the name of.
   */
  channelId?: string;
  /**
   * THE ROLES A PING LINE ABOVE AN EMBED NAMES, and picking one is the opt-in.
   *
   * NAMES, never ids: the composer is only ever shipped `role_name` (see
   * page.tsx), because nine guild snowflakes in a browser bundle would be a
   * leak with nothing asking for it. The names become ids here.
   *
   * A mention inside an embed can never notify anybody whatever
   * `allowed_mentions` says, so a notice that has to reach a phone needs a line
   * of ordinary content above it. That line is what this builds.
   */
  pingRoles?: string[];
  /**
   * WHETHER MENTIONS IN A PLAIN MESSAGE NOTIFY, and the default is silence.
   *
   * With it off, an @everyone typed into the text still READS as a mention and
   * buzzes nobody — the posture /say has and for the same reason: a ping
   * nobody asked for has already reached every phone in the server and cannot
   * be recalled.
   *
   * `pingRoles` implies it: a picked role that did not notify would be a
   * control that does nothing, so the value stored is derived rather than
   * trusted.
   */
  ping?: boolean;
}

export interface EditDiscordMessageInput {
  /** The outbox row, which is also the message Discord already has. */
  id: string;
  /** The new text, in whichever shape the row was posted as. */
  content?: string;
  embed?: { title: string; body: string; type: 'info' | 'warning' | 'urgent' | 'event' };
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
 * An outbox row id, checked rather than handed to Postgres.
 *
 * `discord_outbox.id` is a uuid, and a client-controlled string that is not one
 * comes back from PostgREST as a 22P02 the exec reads as "Something went
 * wrong". Refusing it here costs one regex and says the true thing.
 */
function assertOutboxId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new ExpectedError('That message is not one the console has a record of.');
  }
  return id;
}

/** Whatever arrived where a list of role names belongs, made into one. */
function pickedRoleNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * ROLE NAMES BECOME REAL MENTIONS, AND THIS IS THE ONLY PLACE IT HAPPENS.
 *
 * Shared by queueing and editing because they are the same act on different
 * days: an edit that resolved names differently from the send would rewrite the
 * club's own words on the way past.
 *
 * TWO KINDS OF MENTION, and they are not the same thing:
 *
 *  - The BODY of an embed always resolves, unconditionally. A chip inside an
 *    embed cannot notify anybody whatever `allowed_mentions` says, so there is
 *    nothing for a condition to protect against, and making it conditional
 *    would only make the rendering unpredictable. A reader gets a name they can
 *    hover instead of grey text.
 *  - The PING LINE is what notifies, it is ordinary content above the embed,
 *    and it exists only because somebody picked a role from a list.
 *
 * THE ROLE READ IS SKIPPED ENTIRELY when neither field carries an `@` and no
 * role was picked: the rest of this feature counts its round trips carefully
 * and this is not the place to stop counting.
 *
 * A FAILED READ THROWS RATHER THAN DEGRADING. The whole point of a message like
 * this is the ping, and quietly posting the literal text `@internal` where a
 * mention was meant is the exact failure this exists to remove.
 */
async function resolveForDiscord(
  adminClient: AdminClient,
  guildId: string,
  input: { content: string; embedBody: string; pingRoleNames: string[] },
): Promise<{ content: string; embedBody: string; pingLine: string; mentionedRoles: string[] }> {
  const needsRoles =
    input.pingRoleNames.length > 0 ||
    input.content.includes('@') ||
    input.embedBody.includes('@');

  if (!needsRoles) {
    return {
      content: input.content,
      embedBody: input.embedBody,
      pingLine: '',
      mentionedRoles: [],
    };
  }

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

  const map = (roles ?? []) as { role_name: string; role_id: string }[];
  const resolvedContent = resolveRoleMentions(input.content, map);
  const resolvedBody = resolveRoleMentions(input.embedBody, map);
  const picked = resolveRoleNames(input.pingRoleNames, map);

  // A NAME NOBODY MANAGES IS A REFUSAL, never a silent drop. Dropping it would
  // queue a message that looks like it pings and rings nobody, which is the
  // same failure the throw above exists to prevent. @everyone and @here cannot
  // arrive here at all: they are not rows in `discord_guild_roles`, so they
  // fail this check like any other unknown word.
  if (picked.unknown.length > 0) {
    throw new ExpectedError(
      `"${picked.unknown[0]}" is not one of the roles the club manages, so nothing was queued. ` +
        'Pick one from the list.',
    );
  }

  return {
    content: resolvedContent.text,
    embedBody: resolvedBody.text,
    pingLine: picked.ids.map((id) => `<@&${id}>`).join(' '),
    mentionedRoles: [
      ...new Set([...resolvedContent.matched, ...resolvedBody.matched, ...picked.matched]),
    ].sort(),
  };
}

/** The club's one server, or a refusal that says how to make one. */
async function requireGuildId(adminClient: AdminClient): Promise<string> {
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
  return guildId;
}

/**
 * THE SECOND LENGTH CHECKS, because resolution only ever makes text longer.
 *
 * The typed-length checks are the ones the writer can act on; these catch what
 * expansion added. `discord_outbox` has CHECKs of its own on 2000 and 4096
 * characters (00222), so without these a 1995-character message with a mention
 * in it comes back as a raw Postgres constraint string.
 */
function assertResolvedLengths(content: string, embedBody: string) {
  if (content.length > CONTENT_MAX) {
    throw new ExpectedError(
      `Turning the role names in this message into real mentions takes it to ${content.length} ` +
        `characters, and Discord refuses anything over ${CONTENT_MAX}. Each @role becomes an id, ` +
        'which costs about 22 characters. Cut roughly ' +
        `${content.length - CONTENT_MAX} characters and send it again.`,
    );
  }
  if (embedBody.length > EMBED_DESCRIPTION_MAX) {
    throw new ExpectedError(
      `Turning the role names in this embed's body into real mentions takes it to ` +
        `${embedBody.length} characters, and Discord refuses an embed body over ` +
        `${EMBED_DESCRIPTION_MAX}. Each @role becomes an id, which costs about 22 characters. ` +
        `Cut roughly ${embedBody.length - EMBED_DESCRIPTION_MAX} characters and send it again.`,
    );
  }
}

/** The four categories, refused here rather than as a colour lookup miss. */
function assertEmbedShape(embed: { title: string; body: string; type: string } | undefined) {
  if (embed && !(embed.type in ANNOUNCEMENT_EMBED_COLORS)) {
    throw new ExpectedError('That is not one of the four announcement categories.');
  }
}

/** The typed lengths, before anything is read or resolved. */
function assertTypedLengths(content: string, embedTitle: string, embedBody: string) {
  if (content.length > CONTENT_MAX) {
    throw new ExpectedError(`Discord refuses a message over ${CONTENT_MAX} characters.`);
  }
  if (embedTitle.length > EMBED_TITLE_MAX) {
    throw new ExpectedError(`An embed headline stops at ${EMBED_TITLE_MAX} characters.`);
  }
  if (embedBody.length > EMBED_DESCRIPTION_MAX) {
    throw new ExpectedError(`An embed body stops at ${EMBED_DESCRIPTION_MAX} characters.`);
  }
}

/**
 * Queue one message for the bot to post.
 *
 * EVERY EXPORTED PARAMETER HERE IS A CLIENT-CONTROLLED POST FIELD: a server
 * action is an HTTP endpoint, and nothing stops a caller sending a shape the UI
 * never offers. So `channelId` is validated rather than trusted, `ping` is
 * derived rather than believed, and every `pingRoles` entry has to be a role
 * the club actually manages.
 */
export async function queueDiscordMessage(input: QueueDiscordMessageInput) {
  const admin = await requireCapability('announcements.discord.write');
  const adminClient = createAdminClient();

  const content = typeof input.content === 'string' ? input.content.trim() : '';
  const embedTitle = input.embed ? input.embed.title.trim() : '';
  const embedBody = input.embed ? input.embed.body.trim() : '';
  const pingRoleNames = pickedRoleNames(input.pingRoles);

  if (!content && !embedTitle) {
    throw new ExpectedError('There was nothing to send.');
  }
  // THE PING LINE AND A TYPED MESSAGE ARE THE SAME FIELD, so only one of them
  // can have it. A plain message already notifies the roles named in its own
  // text when the switch is on, and quietly dropping the picked roles here
  // would be a control that does nothing.
  if (content && pingRoleNames.length > 0) {
    throw new ExpectedError(
      'A ping line goes above an embed. A plain message already notifies the roles named in ' +
        'its text.',
    );
  }
  assertTypedLengths(content, embedTitle, embedBody);
  assertEmbedShape(input.embed);

  const guildId = await requireGuildId(adminClient);

  const resolved = await resolveForDiscord(adminClient, guildId, {
    content,
    embedBody,
    pingRoleNames,
  });

  // The typed message, or the ping line that stands above the embed in its
  // place. Never both: the check above refused that combination.
  const outgoing = content ? resolved.content : resolved.pingLine;
  const outgoingEmbedBody = resolved.embedBody;

  assertResolvedLengths(outgoing, outgoingEmbedBody);

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

  // DERIVED, NOT TRUSTED. A picked role that did not notify would be a control
  // that does nothing, and a `ping` of true with nothing to ping only lights a
  // badge over a message that buzzes nobody.
  const ping = resolved.pingLine.length > 0 || input.ping === true;

  // THE EMBED KEYS OFF THE EMBED, never off `content`. These three lines used
  // to read `content ? null : ...`, which was right while a row was one shape
  // or the other; with a ping line present `content` is now always set in the
  // embed shape, and left as they were they would post a bare mention with no
  // embed under it.
  const hasEmbed = embedTitle.length > 0;

  const { data: row, error } = await adminClient
    .from('discord_outbox')
    .insert({
      guild_id: guildId,
      channel_id: channelId,
      content: outgoing || null,
      embed_title: embedTitle || null,
      embed_body: hasEmbed ? outgoingEmbedBody || null : null,
      embed_type: hasEmbed ? (input.embed?.type ?? null) : null,
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
      ...(content
        ? { content: outgoing }
        : { embed_title: embedTitle, embed_body: outgoingEmbedBody }),
      ...(resolved.mentionedRoles.length ? { mentioned_roles: resolved.mentionedRoles } : {}),
    },
  });

  revalidatePath('/announcements');
  return row;
}

/**
 * One queued message, in full, for the composer to edit.
 *
 * A SEPARATE READ RATHER THAN A WIDER LIST. The recent list ships one line per
 * row on purpose, because it exists to answer "did it go out" and not to
 * re-read what the club said; the full text should reach a browser only when
 * somebody has asked to change it.
 *
 * IT RETURNS THE RESOLVED TEXT, so a body already holding `<@&123...>` comes
 * back that way and the exec sees an id where they typed a name. That is safe
 * rather than merely tolerable: `resolveRoleMentions` re-emits an existing
 * mention whole, so saving it again moves nothing. Turning ids back into names
 * on the way out is a real feature and is not this one.
 */
export async function loadDiscordMessage(id: string) {
  await requireCapability('announcements.discord.write');
  const adminClient = createAdminClient();
  const rowId = assertOutboxId(id);

  const { data, error } = await adminClient
    .from('discord_outbox')
    .select(
      'id, content, embed_title, embed_body, embed_type, ping, channel_id, sent_at, discord_message_id',
    )
    .eq('id', rowId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new ExpectedError('That message is not one the console has a record of.');

  return {
    id: data.id as string,
    content: (data.content as string | null) ?? null,
    embedTitle: (data.embed_title as string | null) ?? null,
    embedBody: (data.embed_body as string | null) ?? null,
    embedType: (data.embed_type as string | null) ?? null,
    ping: data.ping === true,
    channelId: data.channel_id as string,
    sentAt: (data.sent_at as string | null) ?? null,
    discordMessageId: (data.discord_message_id as string | null) ?? null,
  };
}

/**
 * Change a message the bot has already posted.
 *
 * AN EDIT IS A RE-QUEUE, not a second message. The row goes back into the
 * pending state with new text and keeps its `discord_message_id`, and the bot
 * PATCHes rather than POSTs when it finds one. So the message in the channel
 * keeps its position, its permalink and its replies, and NOBODY IS NOTIFIED
 * AGAIN: a Discord edit never re-notifies, whatever the ping line says.
 *
 * THE GATE IS `discord_message_id`, NOT `sent_at`. Saving an edit clears
 * `sent_at`, so a row waiting for the tick that carries it is a row somebody is
 * mid-way through fixing: refusing it because it is not "sent" would strand an
 * exec who spotted a second typo. What genuinely cannot be edited is a message
 * Discord has never seen.
 *
 * THE SHAPE IS FIXED. Discord's edit endpoint leaves a field it is not sent
 * standing, so a message that posted as plain text cannot become an embed
 * without the old text remaining above it. The composer disables the picker and
 * this refuses the same change, because the composer is not the only caller.
 *
 * THE CHANNEL IS FIXED for a simpler reason: Discord cannot move a message
 * between channels at all.
 */
export async function editDiscordMessage(input: EditDiscordMessageInput) {
  const admin = await requireCapability('announcements.discord.write');
  const adminClient = createAdminClient();
  const rowId = assertOutboxId(input.id);

  const { data: row, error: readError } = await adminClient
    .from('discord_outbox')
    .select('id, guild_id, channel_id, content, embed_title, sent_at, discord_message_id')
    .eq('id', rowId)
    .maybeSingle();

  if (readError) throw new Error(readError.message);
  if (!row) throw new ExpectedError('That message is not one the console has a record of.');

  if (!row.discord_message_id) {
    throw new ExpectedError(
      'That message has not gone out yet, so there is nothing to edit. It posts within five ' +
        'minutes as it was written.',
    );
  }

  const content = typeof input.content === 'string' ? input.content.trim() : '';
  const embedTitle = input.embed ? input.embed.title.trim() : '';
  const embedBody = input.embed ? input.embed.body.trim() : '';
  const wasEmbed = row.embed_title !== null;

  if (wasEmbed !== Boolean(embedTitle)) {
    throw new ExpectedError(
      'A posted message cannot change between a plain message and an embed. Discord would ' +
        'leave the old text standing beside the new one.',
    );
  }
  if (!content && !embedTitle) {
    throw new ExpectedError('There was nothing to send.');
  }
  assertTypedLengths(content, embedTitle, embedBody);
  assertEmbedShape(input.embed);

  const resolved = await resolveForDiscord(adminClient, row.guild_id as string, {
    content,
    embedBody,
    pingRoleNames: [],
  });

  assertResolvedLengths(resolved.content, resolved.embedBody);

  // THE PING LINE IS NOT TOUCHED. For an embed the row's `content` holds the
  // mentions that were chosen when it was sent, and an edit that cleared it
  // would take the ping line off a message in the channel. Nothing is
  // re-notified by leaving it there.
  const changes = wasEmbed
    ? {
        embed_title: embedTitle,
        embed_body: resolved.embedBody || null,
        embed_type: input.embed?.type ?? null,
      }
    : { content: resolved.content };

  const { data: updated, error } = await adminClient
    .from('discord_outbox')
    .update({
      ...changes,
      // BACK INTO THE QUEUE. The pending index is `sent_at IS NULL AND
      // failed_at IS NULL` (00222), so this is what makes the bot look at the
      // row again, and the attempt budget starts over because this is a new
      // thing to say rather than a retry of the old one.
      sent_at: null,
      claimed_at: null,
      failed_at: null,
      attempts: 0,
      last_error: null,
    })
    .eq('id', rowId)
    // THE RACE FENCE, and it restates the claim's own predicate the way the
    // claim restates the read's (see the outbox route). A row the bot is
    // holding right now would otherwise take this text and then have `sent_at`
    // written over it by the tick that was already mid-post, stranding the
    // correction with nothing on screen to say so. A sent or failed row is not
    // in flight and is free to edit; a stale claim is one the claim itself
    // would take back.
    //
    // THE LAST TWO DISJUNCTS ARE NOT BELT AND BRACES, AND THIS MUST NEVER BE
    // SIMPLIFIED TO `.is('claimed_at', null)`. The success write-back
    // (apps/player/src/app/api/discord/outbox/route.ts) sets `sent_at`,
    // `discord_message_id` and `last_error` and DELIBERATELY LEAVES
    // `claimed_at` STANDING, so every row that has ever been posted still
    // carries a claim. So `claimed_at.is.null` never matches a posted row at
    // all, and `claimed_at.lt.<stale>` matches one only once it is ten minutes
    // old: `sent_at.not.is.null` is the whole of what admits a message that
    // went out moments ago, which is exactly the second typo this feature keeps
    // citing. Narrowing this to an unclaimed check matches zero rows and every
    // edit fails with "being posted right now". Verified against production
    // data, not reasoned from the schema.
    //
    // THE TEN MINUTES IS THE ROUTE'S STALE-CLAIM WINDOW, spelled a second time
    // rather than shared. It must not be made SHORTER than the route's, or this
    // starts handing out rows the next tick still believes it holds.
    //
    // `not.is.null` HAS NO OTHER PRECEDENT IN THIS REPO: it is the only one of
    // these strings that is not copied from a working query, and the test
    // beside it implements the operator in a mock rather than exercising
    // PostgREST, so a green suite says nothing about whether PostgREST parses
    // it. PostgREST documents `not.` as a prefix to any operator but gives no
    // `not.is.null` example. If it does not parse, it arrives as an `error` and
    // goes out through the raw `throw` below, meaning an exec reads a PostgREST
    // string on the first edit anybody attempts. EXERCISE ONE EDIT ON STAGING
    // before this reaches the club.
    .or(
      `claimed_at.is.null,claimed_at.lt.${new Date(Date.now() - 10 * 60_000).toISOString()},` +
        'sent_at.not.is.null,failed_at.not.is.null',
    )
    .select('id');

  if (error) throw new Error(error.message);

  // ZERO ROWS IS NOT AN ERROR IN POSTGREST, it is an empty list, so the only
  // way to notice the fence held is to count what came back.
  if (!updated || updated.length === 0) {
    throw new ExpectedError(
      'That message is being posted in Discord right now, so it was not changed. Try again in ' +
        'a moment.',
    );
  }

  // A NEW ENTRY, NEVER AN AMENDMENT OF THE OLD ONE. The audit log is a history
  // of what the club said and when it changed, and overwriting the original
  // would erase the sentence that was actually in the channel for a while.
  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'discord_message_edited',
    target_type: 'discord_outbox',
    target_id: rowId,
    new_value: {
      channel_id: row.channel_id as string,
      discord_message_id: row.discord_message_id as string,
      ...(wasEmbed
        ? { embed_title: embedTitle, embed_body: resolved.embedBody }
        : { content: resolved.content }),
      ...(resolved.mentionedRoles.length ? { mentioned_roles: resolved.mentionedRoles } : {}),
    },
  });

  revalidatePath('/announcements');
  return { id: rowId };
}

/**
 * The recent list again, for a console watching a queued row.
 *
 * NO PARAMETERS AT ALL, deliberately. Every exported parameter of a server
 * action is a client-controlled POST field, and a filter or a limit here would
 * be a second way to ask this table questions. The five newest rows is the only
 * question the page has, so it is the only one that can be asked.
 *
 * THE SAME GATE THE PAGE USES, because this returns the same rows: an action
 * that read what the page refuses to render would be the back door around that
 * refusal.
 */
export async function readDiscordOutbox(): Promise<OutboxRow[]> {
  await requireCapability('announcements.discord.write');
  return readOutboxRows(createAdminClient());
}

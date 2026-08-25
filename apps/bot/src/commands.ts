import {
  AppApiError,
  clearRevocations,
  deleteLink,
  fetchLeaderboard,
  fetchSessions,
  mintLinkToken,
  writeGuildConfig,
  type SessionSummary,
} from './api.js';
import { postAuditEntry, summaryFromOutcomes } from './audit.js';
import { invalidateConfigCache, loadConfig } from './config.js';
import { DiscordApi } from './discord-api.js';
import { type ManagedRole } from './roles.js';
import { DISPLAY_NAMES, planSetup, type DiscordRole, type MatchedRole } from './setup.js';
import { syncMemberEverywhere } from './sync.js';

// SFU red, the app's single accent (--red: #c00). Keeps Discord output visually
// part of the same product rather than Discord-default blurple.
const CLUB_RED = 0xcc0000;

const LADDER_LABEL: Record<string, string> = {
  singles: 'Singles',
  doubles: 'Doubles',
  points: 'Tournament points',
};

export const COMMAND_DEFINITIONS = [
  {
    name: 'leaderboard',
    description: 'Club ladder standings',
    options: [
      {
        type: 3, // STRING
        name: 'ladder',
        description: 'Which ladder (defaults to doubles)',
        required: false,
        choices: [
          { name: 'Doubles', value: 'doubles' },
          { name: 'Singles', value: 'singles' },
          { name: 'Tournament points', value: 'points' },
        ],
      },
      {
        type: 4, // INTEGER
        name: 'page',
        description: 'Page number',
        required: false,
        min_value: 1,
      },
    ],
  },
  {
    name: 'sessions',
    description: 'Upcoming club sessions',
    options: [],
  },
  {
    name: 'link',
    description: 'Connect your Discord account to your club account',
    options: [],
  },
  {
    name: 'unlink',
    description: 'Disconnect your Discord account and remove your club roles',
    options: [],
  },
  {
    name: 'setup',
    description: 'Create and wire up the club roles in this server',
    options: [
      {
        type: 7, // CHANNEL
        name: 'audit_channel',
        description: 'Where I should log every role change I make (optional)',
        required: false,
        // Text channels only (0) and announcement channels (5). A voice or
        // category channel would be accepted by Discord's picker and then fail
        // on the first message the bot tried to post.
        channel_types: [0, 5],
      },
    ],
    // MANAGE_GUILD (1 << 5). Discord enforces this server-side, so the command
    // is not even visible to anyone else.
    //
    // This gate is the security boundary of the whole feature, and it is worth
    // being explicit about why it sits HERE. Whoever runs /setup decides which
    // Discord role the bot hands to everyone the app says is an exec. Pointing
    // `executives` at a powerful role would grant it to every exec at once.
    // Requiring Manage Server means the people who can run it are exactly the
    // people who could already edit those roles by hand, so it adds no power
    // anyone did not have -- and Discord independently refuses to let a bot
    // create or assign anything above its own position, which caps the blast
    // radius even if this gate were somehow bypassed.
    default_member_permissions: '32',
    // Meaningless in a DM: there is no guild to configure.
    dm_permission: false,
  },
];

/**
 * Commands answered with a deferred reply instead of an immediate one.
 *
 * Discord gives an interaction 3 seconds to be acknowledged. /setup can create
 * nine roles and then write to the app, which is comfortably longer, so it
 * acknowledges first and edits the message when it is actually finished.
 */
export const DEFERRED_COMMANDS = new Set(['setup']);

/**
 * Who ran the command, and where.
 *
 * discordUserId comes from TWO different places depending on context: a guild
 * interaction populates `member.user`, a DM populates `user` and leaves
 * `member` undefined entirely. /link and /unlink are exactly the commands
 * people run in a DM, so reading only one of them breaks the flow for the
 * quietest half of the users.
 */
export interface InteractionContext {
  discordUserId: string | null;
  guildId: string | null;
  /** Both only present for a deferred command; see DEFERRED_COMMANDS. */
  applicationId?: string | null;
  interactionToken?: string | null;
}

interface CommandOption {
  name: string;
  value?: string | number;
}

function option(options: CommandOption[] | undefined, name: string) {
  return options?.find((o) => o.name === name)?.value;
}

function reply(embed: Record<string, unknown>) {
  return { type: 4, data: { embeds: [embed] } };
}

// Ephemeral (flag 64) so failures and empty states don't clutter a shared
// channel. Only the person who ran the command sees them.
function ephemeral(content: string) {
  return { type: 4, data: { content, flags: 64 } };
}

function formatLeaderboardRow(e: {
  rank: number;
  name: string;
  handle: string | null;
  rating: number;
  provisional: boolean;
  wins: number;
  losses: number;
}) {
  // Podium gets a marker; everything else is a plain number so the column stays
  // readable in Discord's proportional font.
  const medal = e.rank === 1 ? '🥇' : e.rank === 2 ? '🥈' : e.rank === 3 ? '🥉' : `\`${e.rank}.\``;
  // The asterisk is not decoration: an unmarked provisional rating reads as
  // settled, and a leaderboard posted in a channel outlives the message.
  const rating = `${e.rating}${e.provisional ? '*' : ''}`;
  return `${medal} **${e.name}** — ${rating} (${e.wins}W ${e.losses}L)`;
}

export async function handleLeaderboard(options: CommandOption[] | undefined) {
  const ladder = String(option(options, 'ladder') ?? 'doubles');
  const page = Number(option(options, 'page') ?? 1);

  const data = await fetchLeaderboard(ladder, page);

  if (data.entries.length === 0) {
    return ephemeral(
      data.page > data.totalPages
        ? `That page is empty — the ${LADDER_LABEL[data.ladder]} ladder has ${data.totalPages} page(s).`
        : 'No ranked players yet.'
    );
  }

  const anyProvisional = data.entries.some((e) => e.provisional);

  return reply({
    title: `${LADDER_LABEL[data.ladder] ?? data.ladder} ladder`,
    color: CLUB_RED,
    description: data.entries.map(formatLeaderboardRow).join('\n'),
    footer: {
      text: [
        `Page ${data.page} of ${data.totalPages}`,
        `${data.totalPlayers} ranked`,
        anyProvisional ? '* rating still provisional' : null,
      ]
        .filter(Boolean)
        .join(' · '),
    },
  });
}

function formatSession(s: SessionSummary) {
  // Discord's <t:unix:F> renders in each viewer's own timezone. Using it means
  // the bot never has to know the club timezone, and a member travelling sees
  // the right local time without the bot doing anything.
  const when = s.startsAt
    ? `<t:${Math.floor(new Date(s.startsAt).getTime() / 1000)}:F>`
    : `${s.date}${s.startTime ? ` ${s.startTime}` : ''}`;

  const parts = [when];
  if (s.location) parts.push(s.location);
  if (s.going !== null) parts.push(`${s.going} going`);

  return `**${s.name ?? 'Session'}**\n${parts.join(' · ')}`;
}

export async function handleSessions() {
  const { sessions } = await fetchSessions();

  if (sessions.length === 0) {
    return ephemeral('No upcoming sessions are open right now.');
  }

  return reply({
    title: 'Upcoming sessions',
    color: CLUB_RED,
    description: sessions.map(formatSession).join('\n\n'),
    footer: { text: 'RSVP on the website' },
  });
}

export async function handleLink(context: InteractionContext) {
  if (!context.discordUserId) {
    // Should be unreachable — Discord always identifies the caller — but the
    // alternative to checking is minting a token bound to "null".
    return ephemeral("Couldn't work out who you are on Discord. Try again.");
  }

  const { url, expiresAt } = await mintLinkToken(context.discordUserId, context.guildId);
  const minutes = Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000));

  return {
    type: 4,
    data: {
      // EPHEMERAL IS LOAD-BEARING, not politeness. This message contains a
      // single-use credential: anyone who could read it could click it first
      // and attach their own club account to this Discord account.
      flags: 64,
      embeds: [
        {
          title: 'Connect your club account',
          color: CLUB_RED,
          description:
            'Open the link below and sign in the way you normally do on the club website. ' +
            'Your roles here are set from your club account once the two are connected.\n\n' +
            `The link works once, and expires in ${minutes} minutes.`,
        },
      ],
      components: [
        {
          type: 1,
          components: [
            // A link button, not a URL in the body: Discord does not unfurl
            // button targets, so the token is not handed to the preview
            // crawler. That matters because an unfurl is a GET from Discord's
            // servers, and the /link page is built so a GET consumes nothing.
            { type: 2, style: 5, label: 'Connect my account', url },
          ],
        },
      ],
    },
  };
}

export async function handleUnlink(context: InteractionContext) {
  if (!context.discordUserId) {
    return ephemeral("Couldn't work out who you are on Discord. Try again.");
  }

  const unlinked = await deleteLink(context.discordUserId);
  if (!unlinked) {
    return ephemeral('Your Discord account is not connected to a club account.');
  }

  // The delete already tombstoned this account (00165's trigger), so the roles
  // WILL come off even if everything below fails. This is the fast path so the
  // member sees it happen now rather than at the next sweep.
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[bot] /unlink: DISCORD_BOT_TOKEN is not set — roles left to the sweep');
    return ephemeral('Disconnected. Your roles will update shortly.');
  }

  let cleared = false;
  try {
    const { registry, auditChannelId } = await loadConfig();
    const api = new DiscordApi({ token });
    const outcomes = await syncMemberEverywhere(
      api,
      registry,
      context.discordUserId,
      null
    );
    cleared = outcomes.every((o) => !o.forbidden && !o.failed);
    // Only when the strip actually succeeded everywhere. A 403 here is the
    // ordinary answer for an exec, and clearing the tombstone on one would
    // discard the revocation permanently.
    if (cleared) await clearRevocations([context.discordUserId]);

    // /unlink strips roles here rather than through POST /sync-member, so it
    // has to write its own entry — otherwise the one action a member can take
    // to remove themselves is the one action the log never records.
    await postAuditEntry(api, auditChannelId, {
      kind: 'member',
      reason: 'unlinked',
      discordUserIds: [context.discordUserId],
      summary: summaryFromOutcomes(context.discordUserId, outcomes),
    });
  } catch (error) {
    console.error('[bot] /unlink: immediate strip failed, left to the sweep:', error);
  }

  return ephemeral(
    cleared
      ? 'Disconnected, and your club roles have been removed.'
      : // Deliberately not "some roles could not be removed": the tombstone
        // means it is a matter of when, not whether.
        'Disconnected. Your roles will update shortly.'
  );
}

/**
 * /setup — make this server's roles exist, and tell the app their ids.
 *
 * The problem it solves is dull but real: wiring a guild by hand means copying
 * nine snowflakes out of Discord's UI into SQL without transposing a digit, and
 * a transposed digit is not a syntax error. It is a role that silently never
 * applies.
 *
 * Idempotent by construction. It matches on the NORMALISED role name, so a club
 * that already has "Session Staff" keeps it rather than gaining a second one,
 * and running it twice is a no-op. Nothing is ever deleted or renamed.
 *
 * Runs AFTER a deferred acknowledgement — see DEFERRED_COMMANDS — so it is free
 * to take as long as nine role creations need.
 */
export async function handleSetup(
  options: CommandOption[] | undefined,
  context: InteractionContext
) {
  const { guildId } = context;
  // dm_permission: false means Discord should never deliver this without a
  // guild. Checked anyway: the alternative is a confusing crash if that ever
  // changes, and the whole command is meaningless without one.
  if (!guildId) return ephemeral('Run this in the server you want to set up.');

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return ephemeral('The bot is not configured with a token.');

  const api = new DiscordApi({ token });

  let botPosition: number;
  let existing: DiscordRole[];
  try {
    [botPosition, existing] = await Promise.all([
      api.getOwnRolePosition(guildId),
      api.listGuildRoles(guildId),
    ]);
  } catch (error) {
    console.error('[bot] setup could not read roles:', error);
    return ephemeral(
      'I could not read this server\'s roles. I need the **Manage Roles** permission.'
    );
  }

  const plan = planSetup(existing, botPosition);

  // Create what is missing, one at a time rather than in parallel: role
  // creation shares a per-guild rate limit bucket, and nine concurrent POSTs
  // just means nine 429s and a slower result.
  const created: MatchedRole[] = [];
  const failed: { role: ManagedRole; reason: string }[] = [];
  for (const role of plan.toCreate) {
    try {
      const made = await api.createGuildRole(guildId, DISPLAY_NAMES[role]);
      created.push({ role, id: made.id, name: made.name });
    } catch (error) {
      // Most likely a 403: no Manage Roles, or the bot's own role is at the
      // very bottom. Collected rather than thrown so one refusal does not
      // discard the eight that worked.
      failed.push({ role, reason: String(error) });
    }
  }

  const resolved = [...plan.matched, ...created];
  if (resolved.length === 0) {
    return ephemeral(
      'I could not resolve or create any roles. Check that I have **Manage Roles**, ' +
        'and that my own role is not at the bottom of the list.'
    );
  }

  const roles: Record<string, string> = {};
  for (const r of resolved) roles[r.role] = r.id;

  // Discord sends a CHANNEL option as the channel's id.
  const auditChannel = option(options, 'audit_channel');
  const auditChannelId = typeof auditChannel === 'string' ? auditChannel : undefined;

  try {
    await writeGuildConfig({ guildId, roles, ...(auditChannelId ? { auditChannelId } : {}) });
  } catch (error) {
    console.error('[bot] setup could not save config:', error);
    // The roles now exist in Discord but the app does not know their ids. Say
    // so plainly: re-running is safe and is the fix, because the roles it just
    // made will match by name on the next pass.
    return ephemeral(
      'I created the roles, but could not save them to the club app. ' +
        'Run /setup again in a moment — it will adopt the roles it just made.'
    );
  }

  // The bot re-reads config on a 60s cache; after a deliberate write there is
  // no reason to serve a stale map for the next minute.
  invalidateConfigCache();

  const lines: string[] = [];
  if (created.length) {
    lines.push(`**Created ${created.length}:** ${created.map((c) => `<@&${c.id}>`).join(' ')}`);
  }
  if (plan.matched.length) {
    lines.push(
      `**Adopted ${plan.matched.length} existing:** ${plan.matched.map((m) => `<@&${m.id}>`).join(' ')}`
    );
  }
  for (const a of plan.ambiguous) {
    lines.push(
      `⚠️ **${a.role}** — ${a.names.length} roles share that name (${a.names.join(', ')}). ` +
        'Rename or delete the duplicates, then run /setup again.'
    );
  }
  for (const u of plan.unusable) {
    lines.push(
      u.reason === 'above_bot'
        ? `⚠️ **${u.name}** sits above my own role, so I cannot assign it. Move my role higher.`
        : `⚠️ **${u.name}** is managed by Discord and cannot be assigned.`
    );
  }
  for (const f of failed) {
    lines.push(`❌ Could not create **${DISPLAY_NAMES[f.role]}** — check my Manage Roles permission.`);
  }

  if (auditChannelId) {
    // Said explicitly because the two failure modes look identical from inside
    // Discord: no audit log at all, and an audit log going somewhere the reader
    // cannot see. Make it a private channel -- the entries mention the members
    // whose roles changed.
    lines.push(
      `**Audit log:** <#${auditChannelId}> — I need **View Channel** and **Send Messages** there.`
    );
  }

  // The single most common way this bot appears to work while doing nothing:
  // every role it manages sits above it, so every assignment 403s. Said up
  // front, every time, rather than left to be discovered by a silent sweep.
  lines.push(
    '',
    '**Next:** drag my role in Server Settings → Roles so it sits **above** every role listed here. ' +
      'Discord will not let me assign a role positioned above my own.'
  );

  return reply({
    title: 'Club roles configured',
    description: lines.join('\n'),
    color: failed.length || plan.ambiguous.length || plan.unusable.length ? 0xf1c40f : 0x2ecc71,
  });
}

export async function dispatch(
  name: string,
  options: CommandOption[] | undefined,
  context: InteractionContext = { discordUserId: null, guildId: null }
) {
  try {
    switch (name) {
      case 'leaderboard':
        return await handleLeaderboard(options);
      case 'sessions':
        return await handleSessions();
      case 'link':
        return await handleLink(context);
      case 'unlink':
        return await handleUnlink(context);
      case 'setup':
        return await handleSetup(options, context);
      default:
        return ephemeral('Unknown command.');
    }
  } catch (err) {
    // Log the real reason, tell the user something true and non-technical. An
    // AppApiError means the app answered badly or not at all; anything else is a
    // bug here. Neither should put a status code or a stack in a channel.
    console.error(`[bot] ${name} failed:`, err);
    return ephemeral(
      err instanceof AppApiError
        ? "Couldn't reach the club app just now — try again in a moment."
        : 'Something went wrong running that command.'
    );
  }
}

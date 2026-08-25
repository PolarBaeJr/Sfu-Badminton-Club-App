import {
  AppApiError,
  clearRevocations,
  deleteLink,
  fetchLeaderboard,
  fetchSessions,
  mintLinkToken,
  type SessionSummary,
} from './api.js';
import { DiscordApi } from './discord-api.js';
import { parseGuildRegistry } from './roles.js';
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
];

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
    const registry = parseGuildRegistry(process.env.DISCORD_GUILDS);
    const outcomes = await syncMemberEverywhere(
      new DiscordApi({ token }),
      registry,
      context.discordUserId,
      null
    );
    cleared = outcomes.every((o) => !o.forbidden && !o.failed);
    // Only when the strip actually succeeded everywhere. A 403 here is the
    // ordinary answer for an exec, and clearing the tombstone on one would
    // discard the revocation permanently.
    if (cleared) await clearRevocations([context.discordUserId]);
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

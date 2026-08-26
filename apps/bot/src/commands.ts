import { randomUUID } from 'node:crypto';
import {
  addSelfRole,
  AppApiError,
  clearRevocations,
  deleteLink,
  fetchLeaderboard,
  fetchSelfRoles,
  fetchSessions,
  fetchTournaments,
  RateLimitedError,
  removeSelfRole,
  submitFeedback,
  SweepManagedRoleError,
  AlreadyLinkedError,
  mintLinkToken,
  writeGuildConfig,
  type FeedbackKind,
  type SessionSummary,
  type TournamentSummary,
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

/**
 * THE TWO GATES, and which one a command needs.
 *
 * They answer different questions, and a command that writes club data needs
 * BOTH. Getting this wrong in either direction is the sort of mistake that
 * looks fine until it does not, so it is written down here rather than decided
 * again per command.
 *
 * GATE 1 -- `default_member_permissions`, enforced by DISCORD, decides who can
 * SEE and RUN the command. It is the only thing that can hide a command from
 * the picker, and the only gate that applies before the bot is involved at all.
 * What it cannot do is know anything about the club: Discord has no idea who
 * the treasurer is.
 *
 * GATE 2 -- the LINKED MEMBER'S APP CAPABILITY, enforced by the app, decides
 * whether the action is actually allowed. This is the real authority. A Discord
 * role is a claim about a person; `players.permission_role` and the capability
 * resolver are what the club's own records say, and they are what the website
 * enforces. Anyone who can edit roles in Discord could otherwise grant
 * themselves whatever a Discord-only check was looking for -- which is exactly
 * the escalation roles.ts refuses to allow in the other direction.
 *
 * So: leave it unset for reads anybody may do, MANAGE_GUILD for Discord
 * plumbing, EXEC_ONLY to keep exec tooling out of everyone else's command list
 * -- and for anything that WRITES to the club's records, EXEC_ONLY to hide it
 * PLUS a capability check on the linked member to enforce it. The visibility
 * gate is tidiness; the capability check is the security boundary. Never let
 * the first stand in for the second.
 */

/**
 * MANAGE_GUILD (1 << 5). Server administration -- creating roles, wiring the
 * bot into the server. Whoever holds it could do the same work by hand.
 */
const MANAGE_GUILD = '32';

/**
 * Hidden from everyone until a server admin grants it to a role.
 *
 * `'0'` is Discord's documented way to say "no default access": the command is
 * invisible in the picker for every non-administrator until somebody opens
 * Server Settings -> Integrations -> SFU Badminton -> Command permissions and
 * allows a role -- normally @Executives, which /setup already creates.
 *
 * WHY '0' RATHER THAN A PERMISSION BIT EXECS HAPPEN TO HOLD. Picking something
 * like Manage Messages would make the audience "whoever holds that Discord
 * permission", which drifts the moment somebody grants Manage Messages to
 * helpers during an unrelated tidy-up. '0' makes the audience an explicit list
 * rather than a side effect.
 *
 * FAILS CLOSED: if nobody ever grants it, the command is simply unavailable
 * outside the admins. The wrong people never get it by accident.
 */
const EXEC_ONLY = '0';

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
    name: 'tournaments',
    description: 'Upcoming club tournaments',
    options: [],
  },
  {
    // NO default_member_permissions, deliberately. EXEC_ONLY is right there in
    // this file and copying it here would make /bug invisible to everyone who
    // is not an admin — which is everyone who would ever report a bug. The
    // audience for these two is the whole club.
    name: 'bug',
    description: 'Report something in the app that is broken',
    // THE WORDS ARE NOT HERE. A title and a body are collected in a modal (see
    // openReportModal) because a slash-command option is a single line that
    // truncates in the client at the width of the input — people write one
    // sentence into it and stop. A paragraph box gets a reproduction.
    //
    // The screenshot has to stay a command option, and that is a Discord
    // limitation rather than a choice: A MODAL CANNOT TAKE A FILE. Text inputs
    // are the only component a modal accepts, so the attachment is picked here,
    // on the interaction before the modal, and carried across.
    options: [
      {
        type: 11, // ATTACHMENT
        name: 'screenshot',
        description: 'Optional: a picture of what went wrong',
        required: false,
      },
    ],
  },
  {
    name: 'feedback',
    description: 'Tell the club what you think',
    // Same shape as /bug: the words come from the modal, the picture cannot.
    // `about` stays a command option rather than moving into the modal, because
    // a modal's only component is a text input — there is no way to offer three
    // choices in one, and a free-text "what is this about" would be a fourth
    // thing to type for a value the route has to validate anyway.
    options: [
      {
        type: 11, // ATTACHMENT
        name: 'screenshot',
        description: 'Optional: a picture, if one helps',
        required: false,
      },
      {
        type: 3, // STRING
        name: 'about',
        description: 'What it is about (defaults to general feedback)',
        required: false,
        choices: [
          { name: 'The club or the app in general', value: 'feedback' },
          { name: 'A tournament', value: 'tournament_feedback' },
          { name: 'Something else', value: 'other' },
        ],
      },
    ],
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
    // Stays MANAGE_GUILD rather than EXEC_ONLY: this one really is server
    // administration, it runs once, and it is what CREATES the @Executives role
    // that EXEC_ONLY commands are later granted to. Gating the bootstrap on the
    // thing it bootstraps would leave a fresh server with no way in.
    default_member_permissions: MANAGE_GUILD,
    // Meaningless in a DM: there is no guild to configure.
    dm_permission: false,
  },
  {
    name: 'rolepicker',
    description: 'Manage the self-serve ping roles members can pick',
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'add',
        description: 'Offer a role for members to give themselves',
        options: [
          { type: 8, name: 'role', description: 'The role to offer', required: true },
          {
            type: 3,
            name: 'label',
            description: 'What the button should say',
            required: true,
          },
          {
            type: 3,
            name: 'emoji',
            description: 'An emoji for the button (optional)',
            required: false,
          },
          {
            type: 4,
            name: 'order',
            description: 'Sort position, lowest first (optional)',
            required: false,
          },
        ],
      },
      {
        type: 1,
        name: 'remove',
        description: 'Stop offering a role. Members who have it keep it.',
        options: [
          { type: 8, name: 'role', description: 'The role to stop offering', required: true },
        ],
      },
      {
        type: 1,
        name: 'post',
        description: 'Post the picker message in this channel',
        options: [],
      },
      {
        type: 1,
        name: 'list',
        description: 'Show which roles are currently on offer',
        options: [],
      },
    ],
    // MANAGE_GUILD, same gate and same reasoning as /setup: whoever runs this
    // decides which roles the bot will hand out on request. Requiring Manage
    // Server means they could already edit those roles by hand, so it grants no
    // power anyone lacked -- and Discord still refuses to let the bot assign
    // anything above its own position, which caps it regardless.
    //
    // EXEC_ONLY rather than MANAGE_GUILD -- which LOOSENS who can run it and
    // TIGHTENS who sees it by default, at the same time.
    //
    // Posting a ping picker is session-running work, and the execs who run
    // sessions are usually not the one or two people holding Manage Server, so
    // gating on that bit puts a routine job behind the person least likely to
    // be around. '0' means an admin grants @Executives once, in Integrations,
    // and the right people have it from then on -- while it stays out of every
    // ordinary member's command list.
    //
    // Safe to widen because of what the command can actually do: it only
    // nominates roles for a picker, 00168 refuses any role the nightly sweep
    // controls, and Discord independently refuses to let the bot assign
    // anything above its own position. There is no path from here to a role
    // somebody could not already have been given by hand.
    //
    // A DISCORD gate, not an app-permission one, and deliberately so: what is
    // configured here is Discord role plumbing, not club data. The commands
    // that write to the club's records check the LINKED member's capability,
    // because that is where the authority actually lives.
    default_member_permissions: EXEC_ONLY,
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
  /**
   * `interaction.data.resolved.attachments`, keyed by attachment id.
   *
   * An attachment option's VALUE is only an id; the file itself lives in this
   * side table. Reading the option alone gets a snowflake and no url, which
   * looks like the picker returning nothing.
   */
  attachments?: Record<string, ResolvedAttachment> | null;
}

export interface ResolvedAttachment {
  url?: string;
  filename?: string;
  content_type?: string;
  size?: number;
}

export interface CommandOption {
  name: string;
  value?: string | number;
  /**
   * Subcommands nest. Discord sends `/rolepicker add role:@X` as a single
   * top-level option named "add" (type 1) whose own `options` carry the real
   * arguments — the arguments are NOT flattened onto the command. Reading
   * `option(options, 'role')` on the outer list therefore finds nothing and
   * looks like the user left a required field blank, which Discord would never
   * have allowed. subcommand() below unwraps one level.
   */
  options?: CommandOption[];
  type?: number;
}

/** The chosen subcommand and its arguments, for a command that has any. */
function subcommand(options: CommandOption[] | undefined) {
  const chosen = options?.find((o) => o.type === 1);
  return { name: chosen?.name ?? null, options: chosen?.options };
}

function option(options: CommandOption[] | undefined, name: string) {
  return options?.find((o) => o.name === name)?.value;
}

function reply(embed: Record<string, unknown>) {
  return { type: 4, data: { embeds: [embed] } };
}

/**
 * An embed only the caller sees.
 *
 * Separate from reply() rather than a boolean argument to it, because the
 * decision is per-command and permanent: /leaderboard is public on purpose,
 * /sessions must not be. A flag at the call site is easy to drop in a refactor
 * and the resulting bug is invisible to the person who caused it — they see
 * their own message either way.
 */
function ephemeralEmbed(embed: Record<string, unknown>) {
  return { type: 4, data: { embeds: [embed], flags: 64 } };
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

/**
 * EPHEMERAL, and that is a correctness property rather than tidiness.
 *
 * The app now returns a schedule filtered to the CALLER — a recreational member
 * is not shown competitive nights, matching the website. A public reply would
 * undo that completely: one competitive member runs /sessions and the bot posts
 * their filtered-for-them schedule into a channel every rec member reads. The
 * filter and the flag only work as a pair.
 *
 * It also means one person's /sessions no longer buries a busy channel in ten
 * embeds, which is a nice consequence and not the reason.
 */
export async function handleSessions(context: InteractionContext) {
  const { sessions, linked } = await fetchSessions(context.discordUserId);

  // Said the same way in both branches: an unlinked caller is seeing club-wide
  // nights only, and should know the list is narrowed rather than empty.
  const footer = linked
    ? 'RSVP on the website'
    : 'Club-wide nights only — run /link to see the sessions for your track.';

  if (sessions.length === 0) {
    return ephemeral(
      linked
        ? 'No upcoming sessions are open right now.'
        : 'No club-wide sessions are open right now.\n\n' +
            'Run **/link** to connect your club account and see the sessions for your track.'
    );
  }

  return ephemeralEmbed({
    title: 'Upcoming sessions',
    color: CLUB_RED,
    description: sessions.map(formatSession).join('\n\n'),
    footer: { text: footer },
  });
}

/**
 * A tournament's dates, as a date and not an instant.
 *
 * <t:unix:F> is right for a session, which starts at a specific minute. A
 * tournament runs a day or a weekend, and rendering it as "Saturday 9:00 AM" in
 * each reader's timezone would state a start time the club has not actually
 * committed to — the schema stores DATE, with no time of day at all. <t:unix:D>
 * shows the date alone, which is the whole of what is known.
 */
function formatTournamentDates(t: TournamentSummary): string {
  // Noon UTC, not midnight: midnight on the club's date is the previous day in
  // every timezone west of it, so a reader in Vancouver would see a tournament
  // starting the day before the website says.
  const stamp = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 1000);
  const start = `<t:${stamp(t.startDate)}:D>`;
  if (!t.endDate || t.endDate === t.startDate) return start;
  return `${start} – <t:${stamp(t.endDate)}:D>`;
}

function formatTournament(t: TournamentSummary): string {
  const parts = [formatTournamentDates(t)];
  if (t.events.length > 0) parts.push(`${t.events.length} event${t.events.length === 1 ? '' : 's'}`);
  if (t.registrationOpen) parts.push('entries open');

  // WHY INELIGIBILITY IS A NOTE AND NOT A FILTER. allowed_memberships is an
  // ENTRY rule — the registration path reads it and refuses — not a visibility
  // one, and the website shows every tournament to every member. Hiding rows
  // here would make Discord show LESS than the site, and the member would find
  // out they cannot enter at the click instead of now.
  const note = t.eligible === false ? '\n_Not open to your membership type._' : '';

  return `**${t.name}**\n${parts.join(' · ')}${note}`;
}

/**
 * EPHEMERAL, for a reason that is one step removed from /sessions'.
 *
 * There is no leak to prevent here — the tournament list is the same for
 * everybody, because the column that pretended to gate it was dropped in 00109
 * and the website filters nothing. What IS per-caller is the eligibility note,
 * and a public reply would announce to the channel which membership type the
 * caller holds. That is nobody else's business, and it would arrive as a side
 * effect of running a command about tournaments.
 */
export async function handleTournaments(context: InteractionContext) {
  const { tournaments, linked } = await fetchTournaments(context.discordUserId);

  if (tournaments.length === 0) {
    return ephemeral('No tournaments are scheduled right now.');
  }

  return ephemeralEmbed({
    title: 'Upcoming tournaments',
    color: CLUB_RED,
    description: tournaments.map(formatTournament).join('\n\n'),
    footer: {
      text: linked
        ? 'Enter on the website'
        : 'Run /link to see which of these you can enter.',
    },
  });
}

export async function handleLink(context: InteractionContext) {
  if (!context.discordUserId) {
    // Should be unreachable — Discord always identifies the caller — but the
    // alternative to checking is minting a token bound to "null".
    return ephemeral("Couldn't work out who you are on Discord. Try again.");
  }

  let url: string;
  let expiresAt: string;
  try {
    ({ url, expiresAt } = await mintLinkToken(context.discordUserId, context.guildId));
  } catch (error) {
    // Caught HERE rather than in dispatch, which turns everything into
    // "couldn't reach the club app" -- true for a timeout, false for a
    // deliberate 409. Re-thrown otherwise so real faults keep their handling.
    if (!(error instanceof AlreadyLinkedError)) throw error;
    return ephemeral(
      'Your Discord account is already connected to a club account.\n\n' +
        'Use **/unlink** first if you want to connect a different one. ' +
        'To move your club account to a different Discord account, run **/link** ' +
        'from that account instead.'
    );
  }

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
    // Do NOT assert a cause here. Two different calls run above, and reading
    // roles needs no permission at all, so "I need Manage Roles" was wrong for
    // every failure that was not a 403 -- it once sent an admin to re-grant a
    // permission the bot already held, because a malformed request 400'd.
    // /setup is admin-only and this reply is ephemeral, so the real reason is
    // safe to show and is the only thing that makes it debuggable.
    return ephemeral(
      "I could not read this server's roles.\n" +
        `Reason: \`${error instanceof Error ? error.message : String(error)}\`\n` +
        'If that mentions 403, I am missing **Manage Roles**.'
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


// ---------------------------------------------------------------------------
// SELF-SERVE PING ROLES
//
// Buttons rather than emoji reactions, and that is a hard constraint rather than
// a preference. Reaction roles need MESSAGE_REACTION_ADD, which is a GATEWAY
// event delivered over a WebSocket the bot has to hold open. This bot is
// HTTP-interactions only -- Discord POSTs to it and it answers -- so it never
// sees a reaction at all. Buttons arrive through the same interaction endpoint
// as slash commands, which is why they work here and reactions could not.
//
// The custom_id carries the role id, and the toggle handler REVALIDATES it
// against the app rather than trusting it. See the note on the app route: a
// picker message posted in September still has September's buttons in January.
// ---------------------------------------------------------------------------

/** Prefix on every picker button's custom_id. `selfrole:<roleId>`. */
const SELF_ROLE_PREFIX = 'selfrole:';

/** Discord: 5 buttons per action row, 5 rows per message. */
const BUTTONS_PER_ROW = 5;

function pickerComponents(roles: { roleId: string; label: string; emoji: string | null }[]) {
  const rows = [];
  for (let i = 0; i < roles.length; i += BUTTONS_PER_ROW) {
    rows.push({
      type: 1, // ACTION_ROW
      components: roles.slice(i, i + BUTTONS_PER_ROW).map((r) => ({
        type: 2, // BUTTON
        style: 2, // SECONDARY -- a ping role is not a destructive or primary act
        label: r.label,
        custom_id: `${SELF_ROLE_PREFIX}${r.roleId}`,
        // Discord wants a custom emoji as {id}, a unicode one as {name}. Sent
        // the wrong way round it rejects the whole message, so the shape is
        // decided by whether the string looks like `name:id`.
        ...(r.emoji ? { emoji: parseEmoji(r.emoji) } : {}),
      })),
    });
  }
  return rows;
}

function parseEmoji(emoji: string) {
  const custom = /^<?a?:?([\w~]+):(\d+)>?$/.exec(emoji);
  if (custom) return { name: custom[1], id: custom[2], animated: emoji.startsWith('<a:') };
  return { name: emoji };
}

async function handleRolePicker(
  options: CommandOption[] | undefined,
  context: InteractionContext
) {
  if (!context.guildId) {
    return ephemeral('Run this in a server, not a DM.');
  }
  const { name: sub, options: args } = subcommand(options);

  if (sub === 'add') {
    const roleId = String(option(args, 'role') ?? '');
    const label = String(option(args, 'label') ?? '').trim();
    const emojiRaw = option(args, 'emoji');
    const order = option(args, 'order');
    if (!roleId || !label) return ephemeral('I need both a role and a label.');

    try {
      await addSelfRole({
        guildId: context.guildId,
        roleId,
        label,
        emoji: emojiRaw ? String(emojiRaw) : null,
        sortOrder: typeof order === 'number' ? order : 0,
      });
    } catch (error) {
      // The one failure worth explaining properly. Everything else falls
      // through to dispatch's generic handler.
      if (!(error instanceof SweepManagedRoleError)) throw error;
      return ephemeral(
        `<@&${roleId}> is one of the club roles I assign automatically from the ` +
          'website, so members must not be able to pick it themselves — I would ' +
          'take it straight back off them on the next nightly sync.\n\n' +
          'Make a separate role for pings and offer that one instead.'
      );
    }

    return ephemeral(
      `Added <@&${roleId}> as **${label}**.\n\n` +
        'Run **/rolepicker post** to put the picker in a channel (or post it again ' +
        'to refresh an existing one — the old message keeps its old buttons).'
    );
  }

  if (sub === 'remove') {
    const roleId = String(option(args, 'role') ?? '');
    if (!roleId) return ephemeral('I need a role.');
    await removeSelfRole(context.guildId, roleId);
    return ephemeral(
      `Stopped offering <@&${roleId}>.\n\n` +
        'Members who already have it keep it — I do not take roles away that ' +
        'people chose. Run **/rolepicker post** again to refresh the buttons.'
    );
  }

  if (sub === 'list' || sub === 'post') {
    const { roles, truncated } = await fetchSelfRoles(context.guildId);

    if (roles.length === 0) {
      return ephemeral(
        'No ping roles are on offer yet. Add one with **/rolepicker add**.'
      );
    }

    if (sub === 'list') {
      return ephemeralEmbed({
        title: 'Ping roles on offer',
        color: CLUB_RED,
        description: roles
          .map((r) => `${r.emoji ? `${r.emoji} ` : ''}**${r.label}** — <@&${r.roleId}>`)
          .join('\n'),
        ...(truncated
          ? { footer: { text: `Only the first 25 can be shown on one message.` } }
          : {}),
      });
    }

    // PUBLIC on purpose, and the only public reply in this command. The whole
    // point is a message everyone in the channel can click.
    return {
      type: 4,
      data: {
        embeds: [
          {
            title: 'Get pinged for the sessions you care about',
            color: CLUB_RED,
            description:
              'Pick the nights you want a heads-up for. Click again to turn one off.\n\n' +
              'These are just notification roles — they do not change what you can ' +
              'sign up for.',
          },
        ],
        components: pickerComponents(roles),
      },
    };
  }

  return ephemeral('Unknown subcommand.');
}

/**
 * A member clicked a picker button.
 *
 * Returns an UPDATE-free ephemeral reply (type 4 + flags 64) rather than
 * editing the picker message: the message is shared, and editing it to say
 * "you now have Competitive nights" would show that to everyone who looks.
 */
export async function handleSelfRoleButton(
  customId: string,
  context: InteractionContext,
  currentRoleIds: readonly string[]
) {
  const roleId = customId.slice(SELF_ROLE_PREFIX.length);
  if (!context.guildId || !context.discordUserId || !roleId) {
    return ephemeral("Couldn't work out who you are. Try again.");
  }

  // REVALIDATED, not trusted. The button came from a message that may be older
  // than the configuration behind it.
  const { roles } = await fetchSelfRoles(context.guildId);
  const offered = roles.find((r) => r.roleId === roleId);
  if (!offered) {
    return ephemeral(
      'That role is not on offer any more. Ask an exec to post a fresh picker.'
    );
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[bot] self-role toggle: DISCORD_BOT_TOKEN is not set');
    return ephemeral('I am not configured to change roles right now.');
  }

  const api = new DiscordApi({ token });
  const holds = currentRoleIds.includes(roleId);

  // roleCall RESOLVES with an outcome rather than throwing -- a try/catch here
  // would report every failure as a success. The outcomes are distinguished
  // because they have different fixes and only one of them is the club's to
  // make: 'forbidden' is the role sitting above the bot's own, which is the
  // single most common way this bot appears to work while doing nothing.
  const outcome = holds
    ? await api.removeRole(context.guildId, context.discordUserId, roleId)
    : await api.addRole(context.guildId, context.discordUserId, roleId);

  if (outcome === 'forbidden') {
    return ephemeral(
      `I am not allowed to give out **${offered.label}**. It sits above my own ` +
        'role in Server Settings → Roles — an exec needs to drag my role above it.'
    );
  }
  if (outcome !== 'ok') {
    console.error(`[bot] self-role toggle ${outcome}: role ${roleId} in ${context.guildId}`);
    return ephemeral(`Couldn't change **${offered.label}** just now. Try again in a moment.`);
  }

  return ephemeral(
    holds
      ? `Removed **${offered.label}** — you won't be pinged for those any more.`
      : `Added **${offered.label}** — you'll be pinged for those.`
  );
}

// ---------------------------------------------------------------------------
// /bug and /feedback
// ---------------------------------------------------------------------------
//
// TWO INTERACTIONS, NOT ONE. The command opens a modal; the modal submit is a
// separate interaction that arrives later and files the report. Discord gives
// no way to do it in one — a modal is a RESPONSE to an interaction, so the
// command cannot both show it and read what was typed into it.
//
// That split is the whole reason for the pending-attachment map below: the
// screenshot is picked on the first interaction and needed on the second, and
// Discord echoes back nothing from the first except the custom_id.

const REPORT_MODAL_PREFIX = 'report:';

/** Discord's own cap on a modal title and on a text input label. */
const MODAL_TITLE_MAX = 45;

// Discord's default upload ceiling for a bot is 25MB, but a screenshot that
// large is a video somebody mislabelled. 8MB is generous for a phone
// screenshot and keeps a single tick of the relay from buffering something
// absurd. Enforced HERE, at pick time, so the reporter is told — the relay
// enforces it again because it is the one doing the download.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * A screenshot waiting for its modal to be submitted.
 *
 * IN MEMORY AND PER PROCESS, deliberately. Losing one costs a picture and never
 * a report: the modal submit finds nothing under its nonce, files the words on
 * their own, and says the screenshot did not make it. A restart mid-report, or
 * a second replica taking the submit, both land there.
 *
 * A database round trip to make this durable would be storing a url that
 * expires in a day, to survive a window of at most fifteen minutes, for a file
 * the reporter can simply attach again.
 */
interface PendingImage {
  url: string;
  filename: string;
  contentType: string;
  /** Set when the file was rejected at pick time; the reason is shown once. */
  rejected: string | null;
  expiresAt: number;
}

// IN-MEMORY, SO THE BOT MUST RUN AS ONE PROCESS. Discord routes the command
// and the modal submit as two independent HTTP requests, so a second replica
// would receive submits for pictures it never stashed and drop them. The
// compose files carry `proxy.unscalable: "true"` for exactly this reason --
// read the comment there before removing it.
//
// Deliberately not durable beyond that: losing this map costs the picture and
// never the report, which is the right way round for state that exists for at
// most fifteen minutes.
const pendingImages = new Map<string, PendingImage>();

// The interaction token behind the modal dies at fifteen minutes, so an entry
// older than that can never be claimed.
const PENDING_TTL_MS = 15 * 60_000;

// A ceiling on the map itself, because an entry is only ever removed by a
// submit that may never come: somebody who opens /bug and presses Escape leaves
// one behind. Eviction is oldest-first and bounded work per insert.
const MAX_PENDING = 200;

function stashImage(nonce: string, image: PendingImage) {
  const now = Date.now();
  for (const [key, value] of pendingImages) {
    if (value.expiresAt <= now) pendingImages.delete(key);
  }
  while (pendingImages.size >= MAX_PENDING) {
    const oldest = pendingImages.keys().next();
    if (oldest.done) break;
    pendingImages.delete(oldest.value);
  }
  pendingImages.set(nonce, image);
}

function claimImage(nonce: string): PendingImage | null {
  const found = pendingImages.get(nonce);
  // Claimed once and then gone, whether or not it was used. A modal cannot be
  // submitted twice, and leaving it would keep an expiring url alive for no
  // reader.
  if (found) pendingImages.delete(nonce);
  if (!found || found.expiresAt <= Date.now()) return null;
  return found;
}

/** Exported for the tests; nothing else has any business reaching in here. */
export function __clearPendingImages() {
  pendingImages.clear();
}

/**
 * /bug and /feedback. One handler, because they differ by which kind is filed.
 *
 * `fixedKind` is 'bug' for /bug and null for /feedback, where the reporter
 * picks from the `about` choices and 'feedback' is the default. Splitting them
 * into two commands rather than one /feedback with a 'bug' choice is a UX call:
 * somebody whose page just broke types "/bug", not "/feedback about:bug".
 *
 * The kind is carried in the custom_id because there is nowhere else to put it:
 * the modal submit arrives as its own interaction with no memory of the command
 * that opened it, and custom_id is the only field that survives the round trip.
 */
function openReportModal(
  fixedKind: FeedbackKind | null,
  options: CommandOption[] | undefined,
  context: InteractionContext
) {
  const chosen = String(option(options, 'about') ?? '');
  const kind: FeedbackKind =
    fixedKind ?? (chosen === 'tournament_feedback' || chosen === 'other' ? chosen : 'feedback');

  const nonce = randomUUID().replace(/-/g, '').slice(0, 12);

  const attachmentId = option(options, 'screenshot');
  if (attachmentId) {
    const file = context.attachments?.[String(attachmentId)];
    const contentType = (file?.content_type ?? '').split(';')[0]?.trim() ?? '';
    const url = file?.url ?? '';

    // NOT an image, or too big. Both are stashed as a REJECTION rather than
    // dropped, so the confirmation can say what happened — a screenshot that
    // silently does not appear reads as the report having failed.
    const rejected = !url
      ? 'the file could not be read'
      : !contentType.startsWith('image/')
        ? 'it is not an image'
        : (file?.size ?? 0) > MAX_IMAGE_BYTES
          ? 'it is over 8MB'
          : null;

    stashImage(nonce, {
      url,
      filename: (file?.filename ?? 'screenshot.png').slice(0, 100),
      contentType: contentType || 'application/octet-stream',
      rejected,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
  }

  const heading = kind === 'bug' ? 'Report a bug' : 'Send the club feedback';

  return {
    type: 9, // MODAL
    data: {
      custom_id: `${REPORT_MODAL_PREFIX}${kind}:${nonce}`,
      title: heading.slice(0, MODAL_TITLE_MAX),
      components: [
        {
          type: 1,
          components: [
            {
              type: 4, // TEXT_INPUT
              custom_id: 'title',
              label: kind === 'bug' ? 'What is broken?' : 'In a few words',
              style: 1, // SHORT
              required: true,
              min_length: 3,
              // Under the column's own 120 so a title never arrives needing to
              // be trimmed by the route.
              max_length: 100,
              placeholder:
                kind === 'bug' ? 'Ladder page spins forever' : 'More weeknight sessions',
            },
          ],
        },
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: 'details',
              label: kind === 'bug' ? 'What happened?' : 'Tell us more',
              style: 2, // PARAGRAPH
              required: true,
              min_length: 5,
              max_length: 1000,
              placeholder:
                kind === 'bug'
                  ? 'What you did, what happened, and what you expected'
                  : 'What is on your mind',
            },
          ],
        },
      ],
    },
  };
}

/** True for a modal submit this module owns. */
export function isReportModal(customId: string | undefined | null): boolean {
  return typeof customId === 'string' && customId.startsWith(REPORT_MODAL_PREFIX);
}

/**
 * The value of one text input in a submitted modal.
 *
 * Modal components arrive NESTED — every input sits inside its own action row —
 * so a flat find on the outer list matches nothing and reads as an empty box
 * the client would never have allowed.
 */
function modalValue(components: ModalComponent[] | undefined, customId: string): string {
  for (const row of components ?? []) {
    for (const child of row.components ?? []) {
      if (child.custom_id === customId) return String(child.value ?? '');
    }
    if (row.custom_id === customId) return String(row.value ?? '');
  }
  return '';
}

export interface ModalComponent {
  type?: number;
  custom_id?: string;
  value?: string;
  components?: ModalComponent[];
}

/**
 * A submitted report modal: file it, and say so.
 *
 * THE REPLY IS EPHEMERAL. Filing a complaint is not publishing it, and a member
 * reporting that a feature is broken has not asked their channel to hear about
 * it. What DOES happen is that the relay puts it in the exec channel a few
 * minutes later (00173) — a private room, not the one they typed in.
 */
export async function handleReportModal(
  customId: string,
  components: ModalComponent[] | undefined,
  context: InteractionContext
) {
  const [, rawKind = '', nonce = ''] = customId.split(':');
  // Anything else is a caller that is not Discord — it only ever sends back a
  // custom_id this file wrote. 'feedback' is the harmless landing spot; passing
  // it through would fail 00172's CHECK and lose the whole report.
  const kind: FeedbackKind =
    rawKind === 'bug' || rawKind === 'tournament_feedback' || rawKind === 'other'
      ? rawKind
      : 'feedback';

  const title = modalValue(components, 'title').trim();
  const details = modalValue(components, 'details').trim();

  if (!details) {
    // Discord's min_length should make this unreachable. Checked anyway,
    // because an empty row looks like a report the club ignored.
    return ephemeral('Add a few words about what happened and try again.');
  }

  const image = nonce ? claimImage(nonce) : null;

  let linked: boolean;
  try {
    ({ linked } = await submitFeedback({
      kind,
      title: title || null,
      body: details,
      imageUrl: image && !image.rejected ? image.url : null,
      discordUserId: context.discordUserId,
      guildId: context.guildId,
    }));
  } catch (err) {
    if (err instanceof RateLimitedError) {
      // Named, so nobody retries a limiter that is working. Every retry pushes
      // their next allowed attempt further out.
      return ephemeral(
        "You've filed a few reports in a short space of time — give it an hour, " +
          'or add the rest to one message next time.'
      );
    }
    throw err;
  }

  const thanks =
    kind === 'bug'
      ? "Thanks — that's filed. The execs read these; if it's something we can " +
        'reproduce it goes on the list.'
      : "Thanks — that's filed and the execs will see it.";

  const notes: string[] = [];
  // ONLY WHEN UNLINKED, and phrased as a limitation of the reply rather than a
  // problem with the report. The report is stored either way; what is missing
  // is a way to get back to them.
  if (!linked) notes.push("You haven't run `/link` yet, so we may not be able to reply.");
  if (image?.rejected) {
    notes.push(`Your screenshot wasn't attached — ${image.rejected}. The report itself is filed.`);
  }

  return ephemeral(notes.length ? `${thanks}\n\n${notes.join('\n')}` : thanks);
}

/** True for a component interaction this module owns. */
export function isSelfRoleButton(customId: string | undefined | null): boolean {
  return typeof customId === 'string' && customId.startsWith(SELF_ROLE_PREFIX);
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
        return await handleSessions(context);
      case 'tournaments':
        return await handleTournaments(context);
      case 'rolepicker':
        return await handleRolePicker(options, context);
      case 'bug':
        return openReportModal('bug', options, context);
      case 'feedback':
        return openReportModal(null, options, context);
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

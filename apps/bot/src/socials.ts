// /socials: the club's links, as one ephemeral embed.
//
// Pure: no fetch, no env, no clock, so the whole reply is testable from a
// payload. commands.ts does the fetch and hands the answer (or null, when the
// app could not be reached) to socialsReply.
//
// THE APP DECIDES WHAT MAY BE SHOWN. The payload comes from
// /api/discord/socials, which reads the same club_socials row as the website's
// footer and re-checks every value, so the bot never prints a link the site
// would refuse. What the bot cannot know when the app is unreachable is
// whether the socials switch or show_discord is off, so the fallback shows the
// invite and the website page and says it is a fallback.

export interface SocialsPayload {
  /** The socials feature switch. */
  enabled: boolean;
  showDiscord: boolean;
  instagramUrl: string | null;
}

export interface SocialsReplyInput {
  /** The app's answer, or null when it could not be reached. */
  payload: SocialsPayload | null;
  /** The club's own invite subdomain, never a discord.gg code. */
  inviteUrl: string;
  /** The website's /socials page, or null when APP_PUBLIC_URL is unset. */
  pageUrl: string | null;
}

// SFU red, as in commands.ts.
const CLUB_RED = 0xcc0000;

// Nothing in this reply should ping anybody. Every value is a URL, but the
// guard costs nothing and outlives whoever adds a free-text field next.
const NO_MENTIONS = { parse: [] as string[] };

export function socialsReply({ payload, inviteUrl, pageUrl }: SocialsReplyInput) {
  if (payload && !payload.enabled) {
    return {
      type: 4,
      data: {
        content: "The club's social links are switched off right now.",
        flags: 64,
        allowed_mentions: NO_MENTIONS,
      },
    };
  }

  const lines: string[] = [];
  const showDiscord = payload ? payload.showDiscord : true;
  if (showDiscord) lines.push(`**Discord:** ${inviteUrl}`);
  if (payload?.instagramUrl) lines.push(`**Instagram:** ${payload.instagramUrl}`);
  if (pageUrl) lines.push(`**On the website:** ${pageUrl}`);

  if (lines.length === 0) {
    return {
      type: 4,
      data: {
        content: 'The club has no social links up right now.',
        flags: 64,
        allowed_mentions: NO_MENTIONS,
      },
    };
  }

  return {
    type: 4,
    data: {
      embeds: [
        {
          title: 'Club socials',
          color: CLUB_RED,
          description: lines.join('\n'),
          footer: {
            text: payload
              ? 'Only you can see this. Run /socials again any time.'
              : "Couldn't reach the club app, so this may be missing a link. The website has the full list.",
          },
        },
      ],
      flags: 64,
      allowed_mentions: NO_MENTIONS,
    },
  };
}

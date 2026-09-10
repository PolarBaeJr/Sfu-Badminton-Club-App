'use client';

import { useMemo } from 'react';
import {
  ANNOUNCEMENT_BODY_MAX,
  EMBED_TITLE_MAX,
  announcementEmbed,
  announcementRelayState,
  embedColorHex,
  type RelayStateResult,
} from '@badminton/shared';
import { resolveRoleMentions, type GuildRole } from '@/lib/discord-mentions';
import type { DiscordRoleOption } from './announcement-shape';
import {
  DISCORD_BG,
  DISCORD_EMBED_BG,
  DISCORD_LINK,
  DISCORD_MUTED,
  DISCORD_TEXT,
  DiscordMarkdown,
} from './discord-markdown';

// What the club's Discord channel gets, drawn next to the thing that decides it.
//
// WHY IT IS HERE AT ALL. The relay has always been correct and always been
// invisible: an exec wrote a post, published it, and then went and looked at
// Discord to find out what it looked like — or, more often, to find out that
// nothing had appeared and had no way to learn why. Both halves of that are
// answerable before publishing, and this is where the answer belongs.
//
// THE PREVIEW IS NOT A MOCK-UP OF THE RELAY, IT IS THE RELAY'S OWN CODE.
// announcementEmbed and announcementRelayState are the functions
// apps/player/.../api/discord/announcements/route.ts and
// apps/bot/src/announcements.ts build the real message from. A preview that
// merely resembled the message would be believed, and would be wrong the first
// time either side changed. The one thing that IS duplicated — the four embed
// colours, because apps/bot has no dependency on @badminton/shared — is pinned
// by a test in both packages.

const MICRO = 'font-mono text-[10px] uppercase tracking-[0.16em]';

/** One line of plain English per state, and never a promise the tick will not keep. */
function relayLine(result: RelayStateResult, channelConfigured: boolean): {
  tone: 'go' | 'hold' | 'stop';
  text: string;
} {
  switch (result.state) {
    case 'posts':
      return { tone: 'go', text: 'Will appear in the Discord channel within five minutes.' };
    case 'edits':
      return { tone: 'go', text: 'Already in Discord — the message there will be edited in place.' };
    case 'in_sync':
      return { tone: 'go', text: 'Already in Discord and up to date. Nothing will change.' };
    case 'retracts':
      return {
        tone: 'stop',
        text: 'In Discord now, but no longer relayable — the message will be deleted.',
      };
    case 'too_old':
      return {
        tone: 'hold',
        // The case a preview that only checked `relayable` would lie about.
        text:
          'Nothing will happen: the relay only picks up announcements touched in the last ' +
          'three days, and this one has not been. Edit it to bring it back into range.',
      };
    case 'no_channel':
      return {
        tone: 'hold',
        text: 'No Discord channel is configured, so this stays on the website. Set one with /config.',
      };
    case 'stays_off':
    default:
      if (result.reason === 'narrow_audience') {
        return {
          tone: 'stop',
          // The reason is a decision, not a fault, so it says so.
          text:
            'Not relayed: it is addressed to some members, and a Discord channel cannot check ' +
            'who is reading it. It stays on the website, where the audience rule is enforced.',
        };
      }
      if (result.reason === 'expired') {
        return { tone: 'stop', text: 'Not relayed: the stop-showing date has passed.' };
      }
      return {
        tone: 'hold',
        text: channelConfigured
          ? 'Drafts are not relayed. Post it and it goes to Discord too.'
          : 'Drafts are not relayed, and no Discord channel is configured either.',
      };
  }
}

/**
 * The picker's shape, in the column names `resolveRoleMentions` reads.
 *
 * Two names for one thing, and neither is redundant: `DiscordRoleOption` is what
 * a component prop should look like, `GuildRole` is what `discord_guild_roles`
 * is called in the database, and the scanner is shared with the server action
 * that reads that table directly.
 */
function guildRoles(roles: DiscordRoleOption[]): GuildRole[] {
  return roles.map((r) => ({ role_name: r.name, role_id: r.id }));
}

export interface DiscordPreviewProps {
  title: string;
  body: string;
  type: string;
  targetAudience: string;
  expiresAt: string | null;
  /**
   * What the announcement's status WILL be. The composer passes 'published',
   * because that is what its primary button does and a preview of the draft
   * path would only ever say "drafts are not relayed".
   */
  status: string;
  channelConfigured: boolean;
  /** Whatever the relay would link the embed title to, or null when unset. */
  url: string | null;
  /** The mapping row, when this announcement already has a message in Discord. */
  posted: { syncedTitle: string; syncedBody: string; syncedType: string } | null;
  /** The freshness column. null for something that does not exist yet. */
  updatedAt: string | null;
  /** The guild roles a chip can be named from. Empty is a legitimate answer. */
  roles: DiscordRoleOption[];
  /**
   * WHETHER THE PATH THIS PREVIEW DESCRIBES RESOLVES ROLE NAMES INTO MENTIONS.
   * REQUIRED, AND DELIBERATELY WITHOUT A DEFAULT.
   *
   * The two call sites answer this differently, and that asymmetry is the whole
   * reason the prop exists rather than a constant:
   *
   *  - The DISCORD composer: true. `resolveForDiscord` in
   *    `lib/actions/discord-message.ts` rewrites `@executives` into `<@&id>` on
   *    the way out, so Discord really does draw a chip.
   *  - The WEBSITE composer: false. The relay
   *    (`apps/player/src/app/api/discord/announcements/route.ts`) posts the body
   *    exactly as it is stored and imports nothing from that module, so the same
   *    keystrokes reach the channel as grey text.
   *
   * No default, so a third call site cannot inherit whichever answer happened to
   * be written first: it is a type error until somebody decides which path they
   * are drawing.
   */
  resolvesRoleNames: boolean;
}

export function DiscordPreview({
  title,
  body,
  type,
  targetAudience,
  expiresAt,
  status,
  channelConfigured,
  url,
  posted,
  updatedAt,
  roles,
  resolvesRoleNames,
}: DiscordPreviewProps) {
  // `new Date()` at render, in a client component, so the expiry and the
  // lookback are answered against the clock of the person reading the preview.
  const now = Date.now();

  // RESOLVE FIRST, THEN SLICE, WHICH IS THE ORDER THE SERVER USES.
  // `resolveForDiscord` rewrites the body and the embed is built from the
  // result, so a mention that grew from `@executives` to eighteen digits and an
  // id wrapper can push the tail past the cap. Slicing first would preview a
  // body Discord never sees.
  //
  // Memoised because it runs on every keystroke of a body that may be 4096
  // characters, in the app whose measured ceiling is render CPU.
  const shown = useMemo(
    () => (resolvesRoleNames ? resolveRoleMentions(body, guildRoles(roles)).text : body),
    [body, resolvesRoleNames, roles],
  );

  const embed = announcementEmbed({ title, body: shown, type, url });
  const state = announcementRelayState(
    {
      status,
      target_audience: targetAudience,
      expires_at: expiresAt,
      // A composer's announcement does not exist yet, so "when was it last
      // touched" is now — which is the truth about the row createAnnouncement
      // is about to write.
      updated_at: updatedAt ?? new Date(now).toISOString(),
      title,
      body,
      type,
    },
    { now, channelConfigured, posted }
  );

  const line = relayLine(state, channelConfigured);
  const trimmedTitle = title.length > EMBED_TITLE_MAX;
  const trimmedBody = body.length > ANNOUNCEMENT_BODY_MAX;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className={`${MICRO} text-[var(--mute)]`}>Discord</span>
        <span className={`${MICRO} text-[var(--mute)]`}>
          {state.state === 'in_sync' || state.state === 'edits' ? 'Posted' : 'Preview'}
        </span>
      </div>

      {/* The picture. aria-hidden because everything in it is repeated in the
          sentence below, and a screen reader walking a facsimile of another
          app's chrome learns nothing it does not already know. */}
      <div
        className="p-3"
        style={{ background: DISCORD_BG }}
        aria-hidden
      >
        <div
          className="flex flex-col gap-1 px-3 py-2"
          style={{
            background: DISCORD_EMBED_BG,
            borderLeft: `4px solid ${embedColorHex(embed.color)}`,
            borderRadius: 4,
            maxWidth: 432, // Discord's own embed width, so wrapping matches.
          }}
        >
          {/* THE TITLE STAYS FLAT ON PURPOSE, and that is not an oversight to be
              tidied up later: an embed title renders no markdown and resolves no
              mention, so `**Closed**` really does reach Discord with its
              asterisks. The composer agrees already, attaching the format
              toolbar to the two textareas and never to the headline Input
              (discord-send.tsx). */}
          {embed.title ? (
            <span
              className="text-[15px] font-semibold leading-snug break-words"
              style={{ color: url ? DISCORD_LINK : DISCORD_TEXT }}
            >
              {embed.title}
            </span>
          ) : (
            <span className="text-[13px] italic" style={{ color: DISCORD_MUTED }}>
              No headline yet
            </span>
          )}

          {embed.description ? (
            <div
              className="text-[14px] leading-relaxed break-words"
              style={{ color: DISCORD_TEXT }}
            >
              <DiscordMarkdown text={embed.description} roles={roles} />
            </div>
          ) : null}
        </div>

        <span className="mt-2 block text-[11px]" style={{ color: DISCORD_MUTED }}>
          {/* Not decoration. The relay never mentions anybody, and an exec
              choosing between the website and Discord should know that a post
              here buzzes nobody's phone. */}
          Posted by the bot. Nobody is pinged.
        </span>
      </div>

      <p
        className={`text-xs leading-relaxed ${
          line.tone === 'go'
            ? 'text-[var(--text-secondary)]'
            : line.tone === 'stop'
              ? 'text-[var(--red)]'
              : 'text-[var(--text-muted)]'
        }`}
      >
        {line.text}
      </p>

      {(trimmedTitle || trimmedBody) && (
        <p className="text-xs text-[var(--text-muted)] leading-relaxed">
          {/* Said here rather than silently cut, because the website shows the
              whole thing and Discord would show a sentence ending mid-word. */}
          Discord will not take all of this — the{' '}
          {trimmedTitle && trimmedBody
            ? `headline is cut at ${EMBED_TITLE_MAX} characters and the body at ${ANNOUNCEMENT_BODY_MAX}`
            : trimmedTitle
              ? `headline is cut at ${EMBED_TITLE_MAX} characters`
              : `body is cut at ${ANNOUNCEMENT_BODY_MAX} characters`}
          . The website shows all of it.
        </p>
      )}
    </div>
  );
}

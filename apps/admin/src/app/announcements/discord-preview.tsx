'use client';

import {
  ANNOUNCEMENT_BODY_MAX,
  EMBED_TITLE_MAX,
  announcementEmbed,
  announcementRelayState,
  embedColorHex,
  type RelayStateResult,
} from '@badminton/shared';

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

/**
 * Discord's own dark surface, hard-coded rather than themed.
 *
 * This is the one panel in the console that must NOT follow the club's palette:
 * it is a picture of somebody else's app, and rendering it in our colours would
 * make it a worse answer to the only question it exists to answer — what does
 * this look like over there.
 */
const DISCORD_BG = '#313338';
const DISCORD_EMBED_BG = '#2b2d31';
const DISCORD_TEXT = '#dbdee1';
const DISCORD_LINK = '#00a8fc';
const DISCORD_MUTED = '#949ba4';

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
}: DiscordPreviewProps) {
  // `new Date()` at render, in a client component, so the expiry and the
  // lookback are answered against the clock of the person reading the preview.
  const now = Date.now();

  const embed = announcementEmbed({ title, body, type, url });
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
            <span
              className="text-[14px] leading-relaxed whitespace-pre-wrap break-words"
              style={{ color: DISCORD_TEXT }}
            >
              {embed.description}
            </span>
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

'use client';

import { DISCORD_BUTTON_SETS, isDiscordButtonSet } from '@badminton/shared';
import {
  DISCORD_BUTTON_PRIMARY,
  DISCORD_BUTTON_SECONDARY,
  DISCORD_MUTED,
  DISCORD_TEXT,
} from './discord-markdown';

// The member buttons, drawn where Discord draws them.
//
// WHY THE PREVIEW SHOWS THEM AT ALL. The picker that adds them says what they
// are in words, and words are not what somebody is deciding about: a row of
// buttons under a club announcement is a visible change to a channel every
// member reads, and the only way to see it used to be to post one and go and
// look. With four sets to choose between (00228) it also answers the question
// the names alone cannot, which is how much of the row each one is.
//
// IT DRAWS THE LABELS AND NOT THE PAYLOAD. The real buttons are built by
// componentsForButtonSet() in apps/bot/src/commands.ts, which this app cannot
// import and must not duplicate; DISCORD_BUTTON_SETS holds the console's copy of
// the labels, pinned against the bot's by a test in both packages.
//
// A SET IT DOES NOT KNOW DRAWS NOTHING. A guessed row of pills would be a
// picture of something the bot will not post: the bot resolves an unknown name
// to no components at all, so an empty space here is the honest answer.
export function DiscordButtonsPreview({ set }: { set: string | null }) {
  if (!isDiscordButtonSet(set)) return null;
  const { buttons, styles } = DISCORD_BUTTON_SETS[set];

  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {buttons.map((label, index) => (
          <span
            key={label}
            className="px-3 py-[6px] text-[14px] font-medium leading-none"
            style={{
              // Style 1 is PRIMARY, everything else here is SECONDARY. Read off
              // the set rather than off the index, so the colours follow the
              // buttons if a second set ever arranges them differently.
              background:
                styles[index] === 1 ? DISCORD_BUTTON_PRIMARY : DISCORD_BUTTON_SECONDARY,
              color: DISCORD_TEXT,
              borderRadius: 3,
            }}
          >
            {label}
          </span>
        ))}
      </div>
      <span className="text-[11px]" style={{ color: DISCORD_MUTED }}>
        {/* Conditional because three of the four sets are one button, and "these"
            and "one" both read as a list. Both wordings keep the same closing
            clause, which is what the preview test looks for. */}
        {buttons.length === 1
          ? 'Members see this under the message. Clicking it replies only to them.'
          : 'Members see these under the message. Clicking one replies only to them.'}
      </span>
    </div>
  );
}

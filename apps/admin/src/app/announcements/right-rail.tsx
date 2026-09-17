'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Card } from '@badminton/ui';
import { useDiscordConsole } from './discord-console-context';
import type { ComposerMode } from './announcement-shape';

const MICRO = 'font-mono text-[10px] uppercase tracking-[0.16em]';

// The right column's one list card: what the club has posted, or what it has
// lately said in Discord. One card with a switch, rather than two cards stacked.
//
// IT FOLLOWS THE COMPOSER, IT DOES NOT DRIVE IT. Choosing "Discord message" on
// the left swaps this to the Discord log, which is the whole point. The reverse
// is deliberately NOT wired: a viewer holding `announcements.discord.write`
// without `announcements.create.write` gets `modes = ['discord']` and has no
// website composer to render (announcement-shape.ts:284), so letting this strip
// write back into the shared mode would strand them in a mode their own card
// cannot draw. Reading the posted list has to stay possible for that viewer,
// which is why the switch keeps its own state and only syncs downward.
//
// BOTH PANELS STAY MOUNTED AND THE INACTIVE ONE IS HIDDEN, the same posture the
// composers take. `DiscordRecent` polls itself while a row is queued and holds
// the id of the row being opened; unmounting it on every switch would restart
// that poll and drop the in-flight open. `[hidden]` is `display:none`, which
// leaves the React state alive.

export function RightRail({
  posted,
  postedCount,
  discord,
  discordCount,
  showDiscord,
}: {
  posted: ReactNode;
  postedCount: number;
  discord: ReactNode;
  discordCount: number;
  /** False when the viewer cannot send to Discord: then there is nothing to switch to. */
  showDiscord: boolean;
}) {
  const { mode } = useDiscordConsole();
  const [view, setView] = useState<ComposerMode>(mode);

  // Follows the strip on the left. `mode` alone in the dependency list: this
  // must re-run when the composer changes and at no other time, or a click on
  // the switch below would be undone by the next render.
  useEffect(() => {
    setView(mode);
  }, [mode]);

  // Without a Discord side there is only ever one list, whatever `mode` says.
  const on: ComposerMode = showDiscord ? view : 'website';

  const count =
    on === 'website'
      ? `${postedCount} ${postedCount === 1 ? 'post' : 'posts'}`
      : `${discordCount} ${discordCount === 1 ? 'message' : 'messages'}`;

  return (
    <Card padding={false}>
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--line)]">
        {showDiscord ? (
          <div className="flex items-center gap-4">
            {(['website', 'discord'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setView(key)}
                aria-current={on === key ? 'page' : undefined}
                // `py-2 -my-2` widens the hit area without growing the header.
                className={`${MICRO} py-2 -my-2 ${
                  on === key
                    ? 'text-[var(--text-primary)] underline decoration-2 decoration-[var(--red)] underline-offset-[6px]'
                    : 'text-[var(--mute)] hover:text-[var(--text-secondary)]'
                }`}
              >
                {key === 'website' ? 'Posted' : 'Discord'}
              </button>
            ))}
          </div>
        ) : (
          // The mockup said THIS TERM. This list is deliberately NOT
          // term-scoped: an admin has to be able to reach a retired season's
          // posts to edit or remove them, and 00085 retires them from the
          // MEMBER feed, not from here.
          <span className={`${MICRO} text-[var(--mute)]`}>Posted</span>
        )}
        <span className={`${MICRO} text-[var(--mute)]`}>{count}</span>
      </div>

      {/* THESE WRAPPERS CARRY NO CLASS, and must not gain one. `hidden` works
          through `[hidden] { display: none }`, so any display utility on the
          same element wins on specificity and un-hides the panel, stacking both
          lists. Spacing belongs inside each panel. */}
      <div hidden={on !== 'website'}>{posted}</div>
      {showDiscord && <div hidden={on !== 'discord'}>{discord}</div>}
    </Card>
  );
}

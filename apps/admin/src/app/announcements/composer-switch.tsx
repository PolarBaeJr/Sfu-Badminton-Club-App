'use client';

import { useEffect } from 'react';
import { Tabs } from '@badminton/ui';
import { Composer, type DiscordContext } from './actions';
import { DiscordSend } from './discord-send';
import { useDiscordConsole } from './discord-console-context';
import {
  COMPOSER_MODE_LABELS,
  showsModeSelector,
  type ComposerMode,
  type DiscordChannelOption,
  type DiscordRoleOption,
} from './announcement-shape';

// One card, two composers, a strip at the top to choose between them.
//
// BOTH COMPOSERS STAY MOUNTED AND THE INACTIVE ONE IS HIDDEN, because switching
// modes must not silently destroy a half-typed announcement. `Composer` holds
// its whole `form` in local state (actions.tsx:248) and `DiscordSend` holds
// seven separate pieces (discord-send.tsx:69-76); unmounting throws all of that
// away with no warning and no draft to go back to. `[hidden]` is
// `display:none`, which keeps the React state alive.

export function ComposerSwitch({
  modes,
  pushReachable,
  discord,
  channelConfigured,
  channels,
  roles,
  ambiguousRoleNames,
}: {
  modes: ComposerMode[];
  pushReachable: number | null;
  discord: DiscordContext | null;
  channelConfigured: boolean;
  channels: DiscordChannelOption[];
  roles: DiscordRoleOption[];
  /** Server roles the picker had to drop. Passed through: see DiscordSend. */
  ambiguousRoleNames: string[];
}) {
  // MODE IS NOT LOCAL STATE ANY MORE. The list card in the right column follows
  // it (right-rail.tsx), and the provider is the only boundary that spans both
  // columns. Which mode opens is still `modes[0]`, handed to the provider as
  // `initialMode` in page.tsx.
  const { pending, mode, setMode } = useDiscordConsole();

  // EDITING A DISCORD MESSAGE HAS TO SHOW THE DISCORD COMPOSER. The Edit button
  // is in the card below this one, and without this an exec who was writing a
  // website post would press it and watch nothing happen: the fields would fill
  // in behind a `display:none`.
  //
  // `pending` alone in the dependency list, deliberately. `modes` is a fresh
  // array on every render, so including it would re-run this after each one and
  // pin the tab strip to Discord for as long as an edit is open.
  //
  // THE WEBSITE PATH HAS NO TWIN OF THIS EFFECT, and that asymmetry is on
  // purpose rather than an oversight to tidy away: `startWebsiteEdit` sets the
  // mode in the same handler that sets the pending row
  // (discord-console-context.tsx). The website composer scrolls itself into
  // view, and a child's effects commit before a parent's, so switching the mode
  // from up here would leave that scroll running against a `display:none`
  // element, where it does nothing and never runs again.
  useEffect(() => {
    if (pending) setMode('discord');
  }, [pending]);

  return (
    // The rhythm both composers already use internally (actions.tsx:279,
    // discord-send.tsx:109). A display:none panel contributes no flex gap.
    <div className="flex flex-col gap-[14px]">
      {showsModeSelector(modes) && (
        <Tabs
          tabs={modes.map((m) => ({ id: m, label: COMPOSER_MODE_LABELS[m] }))}
          activeTab={mode}
          onChange={(id) => setMode(id as ComposerMode)}
        />
      )}

      {/* THESE TWO WRAPPERS CARRY NO CLASS, and must not gain one. `hidden`
          works through `[hidden] { display: none }`, so ANY display utility on
          the same element (`flex`, `block`, `grid`) wins on specificity and
          un-hides the panel — stacking both composers, which is the exact bug
          this card exists to fix. Spacing belongs on the root above. */}
      {modes.includes('website') && (
        <div hidden={mode !== 'website'}>
          <Composer pushReachable={pushReachable} discord={discord} />
        </div>
      )}

      {modes.includes('discord') && (
        <div hidden={mode !== 'discord'}>
          <DiscordSend
            channelConfigured={channelConfigured}
            channels={channels}
            roles={roles}
            ambiguousRoleNames={ambiguousRoleNames}
          />
        </div>
      )}
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
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
}: {
  modes: ComposerMode[];
  pushReachable: number | null;
  discord: DiscordContext | null;
  channelConfigured: boolean;
  channels: DiscordChannelOption[];
  roles: DiscordRoleOption[];
}) {
  const [mode, setMode] = useState<ComposerMode>(modes[0] ?? 'website');
  const { pending } = useDiscordConsole();

  // EDITING A DISCORD MESSAGE HAS TO SHOW THE DISCORD COMPOSER. The Edit button
  // is in the card below this one, and without this an exec who was writing a
  // website post would press it and watch nothing happen: the fields would fill
  // in behind a `display:none`.
  //
  // `pending` alone in the dependency list, deliberately. `modes` is a fresh
  // array on every render, so including it would re-run this after each one and
  // pin the tab strip to Discord for as long as an edit is open.
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
          />
        </div>
      )}
    </div>
  );
}

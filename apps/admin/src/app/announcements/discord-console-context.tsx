'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ComposerMode } from './announcement-shape';

// The state the Discord composer and the recent list share.
//
// WHY A CONTEXT AND NOT A PROP. The two halves sit in different grid COLUMNS:
// the composer is inside `ComposerSwitch` at the top of the left column, and
// the recent list is a PANEL of the single list card in the right one
// (`right-rail.tsx`), shown when that card's switch is on Discord. A queued row
// that is about to fail must stay on screen while somebody goes back to the
// website composer, so it cannot be folded into the composer's own card.
// Pressing Edit in that list has to fill the composer, and with the whole grid
// between them a prop would have to be threaded down through every card in both
// columns.
//
// IT ALSO CARRIES THE MODE, because the list card follows the composer: picking
// "Discord message" on the left swaps that card from the posted list to the
// Discord log. The provider is the only boundary that spans both columns.
//
// IT CARRIES A NUDGE AS WELL AS AN EDIT. The list polls itself while anything
// is queued, but a message that has just been sent or re-queued should appear
// at once rather than up to four seconds later, and only the composer knows a
// send happened.

export interface PendingDiscordEdit {
  /** The outbox row, which is also the message Discord already has. */
  id: string;
  content: string | null;
  embedTitle: string | null;
  embedBody: string | null;
  embedType: string | null;
  /**
   * The member buttons the row already carries, or null.
   *
   * Not decoration: when this is set the composer preselects it in the picker
   * and STOPS OFFERING "No buttons", because buttons can be added to a message
   * Discord already has, or swapped for another set, and not taken off it. The
   * picker itself stays enabled: the server refuses only the removal, and
   * disabling it would make the swap impossible.
   */
  buttonSet: string | null;
}

interface DiscordConsoleValue {
  /**
   * The message somebody has asked to edit.
   *
   * ITS IDENTITY IS THE SIGNAL, not its contents: pressing Edit twice on the
   * same row hands over a new object, so the composer refills both times.
   */
  pending: PendingDiscordEdit | null;
  startEdit: (edit: PendingDiscordEdit) => void;
  clearEdit: () => void;
  /** Bumped by the composer after a send or an edit. */
  nudge: number;
  refreshRecent: () => void;
  /**
   * Which composer is showing.
   *
   * IT LIVES HERE RATHER THAN IN `ComposerSwitch` because the list card in the
   * other column follows it: picking "Discord message" swaps that card from the
   * posted list to the Discord log. The provider already spans the whole grid,
   * so it is the only place both columns can read.
   */
  mode: ComposerMode;
  setMode: (mode: ComposerMode) => void;
}

const DiscordConsoleContext = createContext<DiscordConsoleValue | null>(null);

export function DiscordConsoleProvider({
  children,
  initialMode,
}: {
  children: ReactNode;
  /** Which composer opens. `composerModes` puts website first when both are held. */
  initialMode: ComposerMode;
}) {
  const [pending, setPending] = useState<PendingDiscordEdit | null>(null);
  const [nudge, setNudge] = useState(0);
  const [mode, setMode] = useState<ComposerMode>(initialMode);

  const value = useMemo<DiscordConsoleValue>(
    () => ({
      pending,
      startEdit: setPending,
      clearEdit: () => setPending(null),
      nudge,
      refreshRecent: () => setNudge((n) => n + 1),
      mode,
      setMode,
    }),
    [pending, nudge, mode],
  );

  return (
    // NO ELEMENT OF ITS OWN. This wraps the whole grid, and any wrapper here
    // would become the grid's only child, collapsing both columns into one.
    <DiscordConsoleContext.Provider value={value}>{children}</DiscordConsoleContext.Provider>
  );
}

export function useDiscordConsole(): DiscordConsoleValue {
  const value = useContext(DiscordConsoleContext);
  if (!value) {
    // LOUD, because the failure is otherwise an Edit button that does nothing.
    throw new Error('The Discord console needs DiscordConsoleProvider above it.');
  }
  return value;
}

'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

// The one piece of state the Discord composer and the list underneath it share.
//
// WHY A CONTEXT AND NOT A PROP. The two halves are siblings in two different
// cards: the composer is inside `ComposerSwitch` in the card at the top of the
// left column, and the recent list is its own card below, because a queued row
// that is about to fail must stay on screen while somebody goes back to the
// website composer. Pressing Edit in the second has to fill the first, and
// hoisting either one into the other would either nest a card inside a card or
// hide a failure behind a tab.
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
   * Not decoration: the composer shows the switch on and DISABLED when this is
   * set, because buttons can be added to a message Discord already has and not
   * taken off it, and the server refuses the removal either way.
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
}

const DiscordConsoleContext = createContext<DiscordConsoleValue | null>(null);

export function DiscordConsoleProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingDiscordEdit | null>(null);
  const [nudge, setNudge] = useState(0);

  const value = useMemo<DiscordConsoleValue>(
    () => ({
      pending,
      startEdit: setPending,
      clearEdit: () => setPending(null),
      nudge,
      refreshRecent: () => setNudge((n) => n + 1),
    }),
    [pending, nudge],
  );

  return (
    // NO ELEMENT OF ITS OWN. This wraps a grid column, and any wrapper here
    // would become the grid item instead of the column it holds.
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

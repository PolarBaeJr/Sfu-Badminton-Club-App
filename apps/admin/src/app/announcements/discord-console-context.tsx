'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type {
  AnnouncementStatus,
  AnnouncementType,
  ComposerMode,
  PostedMapping,
  TargetAudience,
} from './announcement-shape';

// The state each composer shares with the list its Edit button lives in: the
// Discord one, and now the website one too.
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
// THE WEBSITE PENDING EDIT BELONGS HERE FOR THE SAME REASON, NOT AS A SECOND
// PROVIDER. Pressing Edit on a posted row fills the website composer, and the
// posted list is the OTHER panel of that same right-hand card while the composer
// is at the top of the left one. This provider is the only boundary spanning
// both columns, so a sibling context would be a second copy of the same
// boundary, drawn around the same two cards.
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

export interface PendingWebsiteEdit {
  /** The announcement row somebody pressed Edit on. */
  id: string;
  title: string;
  body: string;
  type: AnnouncementType;
  target_audience: TargetAudience;
  pinned: boolean;
  send_push: boolean;
  status: AnnouncementStatus;
  expires_at: string | null;
  /**
   * The row's Discord mapping, or null when Discord has never had this post.
   *
   * Carried rather than looked up because the composer is SHARED: it has no row
   * of its own to read a mapping off, and the preview it draws needs one to say
   * whether the channel is already holding an older version of these words. The
   * page threads the same mapping into the row that hands this over, so the two
   * cannot answer differently.
   */
  posted: PostedMapping | null;
}

// The fields above are declared here rather than imported as `RowAnnouncement`
// from `actions.tsx`, which is where that shape lives: `actions.tsx` imports
// this file, so reaching back for the row type would be an import cycle. Only
// leaf types from `announcement-shape.ts` come in.

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
  /**
   * The announcement somebody has asked to edit in the website composer.
   *
   * ITS IDENTITY IS THE SIGNAL, not its contents, exactly as `pending` above:
   * pressing Edit twice on the same row hands over a fresh object, so the
   * composer refills both times.
   */
  pendingWebsite: PendingWebsiteEdit | null;
  startWebsiteEdit: (edit: PendingWebsiteEdit) => void;
  clearWebsiteEdit: () => void;
  /**
   * Whether the left card actually draws the website composer.
   *
   * The posted list's Edit button asks this before it routes: update and create
   * are separate keys, so a viewer can hold Edit with no composer to fill, and
   * for them Edit has to keep opening the dialog.
   */
  hasWebsiteComposer: boolean;
}

const DiscordConsoleContext = createContext<DiscordConsoleValue | null>(null);

export function DiscordConsoleProvider({
  children,
  initialMode,
  hasWebsiteComposer,
}: {
  children: ReactNode;
  /** Which composer opens. `composerModes` puts website first when both are held. */
  initialMode: ComposerMode;
  /** Whether `modes` includes 'website', so the posted list knows where Edit goes. */
  hasWebsiteComposer: boolean;
}) {
  const [pending, setPending] = useState<PendingDiscordEdit | null>(null);
  const [pendingWebsite, setPendingWebsite] = useState<PendingWebsiteEdit | null>(null);
  const [nudge, setNudge] = useState(0);
  const [mode, setMode] = useState<ComposerMode>(initialMode);

  const value = useMemo<DiscordConsoleValue>(
    () => ({
      pending,
      // NEITHER OF THESE TWO TOUCHES THE OTHER'S PENDING EDIT. Starting a
      // website edit leaves a half-composed Discord message exactly where it
      // was, and the other way round: that is the same rule `composer-switch`
      // keeps by hiding the inactive composer rather than unmounting it
      // (composer-switch.tsx:18-23), and clearing the other side here would
      // throw away typing the switch itself is careful to preserve.
      startEdit: setPending,
      clearEdit: () => setPending(null),
      nudge,
      refreshRecent: () => setNudge((n) => n + 1),
      mode,
      setMode,
      pendingWebsite,
      // THE MODE SWITCH HAPPENS HERE, IN THE SAME HANDLER, and deliberately NOT
      // in an effect inside `ComposerSwitch` the way the Discord path does it
      // (composer-switch.tsx:65-67). Do not "fix" this back into symmetry.
      // React commits a child's effects before its parent's, so the composer's
      // own scroll effect, keyed on this object, would run while the wrapper
      // around it is still `hidden`: `scrollIntoView` on a `display:none`
      // element does nothing, and the effect would not run again once the
      // parent effect un-hid it. Batching both updates means the composer is
      // already visible when its effect fires.
      startWebsiteEdit: (edit: PendingWebsiteEdit) => {
        setPendingWebsite(edit);
        setMode('website');
      },
      clearWebsiteEdit: () => setPendingWebsite(null),
      hasWebsiteComposer,
    }),
    [pending, nudge, mode, pendingWebsite, hasWebsiteComposer],
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

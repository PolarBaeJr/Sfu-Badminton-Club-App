'use client';

import { useRouter } from 'next/navigation';
import type { MouseEvent, ReactNode } from 'react';

/** Anything inside the row that owns its own click. A row carries its own actions,
 *  Ban, Inactive and their dialogs; every one of them must keep working, so a
 *  click that started inside one is never a navigation.
 *  `dialog`/`[role=dialog]` are here because a confirm panel that renders in
 *  place rather than through a portal is still a descendant of this <tr>, and
 *  clicking its padding must not send the officer to a different page
 *  mid-confirmation. */
const INTERACTIVE =
  'a,button,input,select,textarea,label,dialog,[role="button"],[role="menuitem"],[role="dialog"]';

/**
 * A table row that is, as a whole, a link.
 *
 * Written for the roster and now shared: the tournaments index wanted the same
 * thing, and a second copy would have been a second place to get the guards
 * wrong.
 *
 * This is deliberately an ENHANCEMENT and not the only way in: the member's
 * name in the first cell is a real `<Link>`, and so is `View`. A `<tr>` cannot
 * be wrapped in an anchor, and a row with only an onClick is unreachable by
 * keyboard — so the anchors stay and this adds the mouse affordance officers
 * expect from a table of records. Remove either anchor and the row becomes
 * mouse-only.
 */
export function RowLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();

  function handleClick(event: MouseEvent<HTMLTableRowElement>) {
    // A control already handled it, or asked not to be followed.
    if (event.defaultPrevented) return;
    if ((event.target as HTMLElement).closest(INTERACTIVE)) return;

    // Dragging across a name to copy it is not a request to leave the page.
    if (window.getSelection()?.toString()) return;

    // Match what the browser would do with a modified click on a real link,
    // rather than yanking the current tab somewhere the officer did not ask.
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }

    router.push(href);
  }

  return (
    <tr className={className} onClick={handleClick}>
      {children}
    </tr>
  );
}

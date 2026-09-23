// THE TOP BAR AS GROUPS, with no React in it.
//
// Both apps grew a flat row of links that no longer fits, so the bar is now a
// short list of entries, each either a plain link or a named group that opens
// as a menu. Kept framework-free for the same reason as ./multi-select.ts: the
// visibility and active-route rules are what can go wrong, and a test can reach
// them here without mounting a component.
//
// Adding a destination to a group is one line in the caller's layout; nothing
// here needs to change.

export type NavGroup<T extends { href: string }, I = unknown> = {
  /** Stable across renders: callers key on it so a re-render keeps an open menu open. */
  id: string;
  label: string;
  icon?: I;
  items: T[];
};

export type NavEntry<T extends { href: string }, I = unknown> =
  | { kind: 'link'; item: T }
  | { kind: 'group'; group: NavGroup<T, I> };

/**
 * The entries this viewer should see: hidden items dropped, and any group left
 * with nothing in it dropped as well, so a menu never opens onto an empty panel.
 */
export function visibleEntries<T extends { href: string }, I>(
  entries: NavEntry<T, I>[],
  isVisible: (item: T) => boolean,
): NavEntry<T, I>[] {
  const out: NavEntry<T, I>[] = [];
  for (const entry of entries) {
    if (entry.kind === 'link') {
      if (isVisible(entry.item)) out.push(entry);
      continue;
    }
    const items = entry.group.items.filter(isVisible);
    if (items.length > 0) out.push({ kind: 'group', group: { ...entry.group, items } });
  }
  return out;
}

/**
 * Is `pathname` at or under `href`?
 *
 * By whole segment, not by string prefix: /events must not light up on
 * /eventsx. The root only matches itself, or it would match everything.
 */
export function isRouteActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isGroupActive<T extends { href: string }>(
  pathname: string,
  group: NavGroup<T, unknown>,
): boolean {
  return group.items.some((item) => isRouteActive(pathname, item.href));
}

/** Every item in the layout, groups opened out, in display order. */
export function flattenEntries<T extends { href: string }, I>(entries: NavEntry<T, I>[]): T[] {
  return entries.flatMap((entry) => (entry.kind === 'link' ? [entry.item] : entry.group.items));
}

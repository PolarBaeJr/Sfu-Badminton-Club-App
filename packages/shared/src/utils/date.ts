/**
 * Canonical date helpers used across both apps. Do not duplicate inline.
 */

/**
 * "5m ago" / "3h ago" / "2d ago" / "just now" — short relative time string.
 */
export function formatRelative(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const m = Math.floor(diff / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.floor(h / 24);
    return `${days}d ago`;
  } catch {
    return iso;
  }
}

/**
 * "May 2, 2026" — short month, numeric day, full year. Default formatter
 * for admin tables.
 */
export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

/**
 * "Apr 30" — short month + numeric day, no year. Used in compact dispute
 * filings and admin row labels where the year is implicit (current season).
 */
export function formatDateShort(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

/**
 * "Fri 7 PM" — friendly weekday + 12h hour. Used for scheduled challenge
 * proposals.
 */
export function formatScheduled(iso: string): string {
  try {
    const d = new Date(iso);
    const day = d.toLocaleDateString('en-US', { weekday: 'short' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric' });
    return `${day} ${time}`;
  } catch {
    return iso;
  }
}

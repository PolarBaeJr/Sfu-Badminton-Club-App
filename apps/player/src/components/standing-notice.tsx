import type { AccountStanding } from '@badminton/shared';

/**
 * The line that replaces a control we withheld. `activity` names what is gone,
 * in the plural and capitalised — "Challenges", "RSVP and check-in" — because
 * a button vanishing with no explanation reads as the app being broken. The
 * app-wide StandingBanner carries the full explanation and what to do about
 * it, so this stays to one clause.
 *
 * No hooks and no 'use client': server pages and client controls both render
 * it, and the standing is always passed in explicitly.
 */
export function StandingNote({
  standing,
  activity,
  className = 'text-xs text-[var(--text-secondary)] italic',
  style,
}: {
  standing: AccountStanding;
  activity: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  if (standing.ok) return null;
  return (
    <p className={className} style={style} role="status">
      {activity} paused — {standing.reason}.
    </p>
  );
}

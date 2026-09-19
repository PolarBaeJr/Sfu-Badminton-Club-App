'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { HistorySeason } from '@/lib/season-history';

/**
 * Which term a season-scoped screen is showing.
 *
 * A native `<select>`. The admin console has a searchable combobox for the same
 * job and this is deliberately not that: a member has one or two past terms
 * where an exec browses five years of them, and on a phone the OS picker is a
 * full-height wheel with system-sized rows — a better thumb target than any
 * popover this app could draw, and it needs no outside-click handling, no
 * keyboard implementation and no scroll trapping.
 *
 * What IS shared with the console is the contract, which is the part that had a
 * bug in it: the choice lives in the URL so it survives a server-component
 * re-render and can be sent to somebody, the active season is the BARE path so
 * "now" has one canonical address, and every other query parameter is carried
 * across rather than rebuilt — changing the season must change the season and
 * nothing else.
 *
 * Renders nothing when there is only the current term to look at, so a club in
 * its first season never sees a control with one option in it.
 *
 * `basePath` is required rather than defaulted to /my-stats. Two screens are
 * season-scoped now (/my-stats and /leaderboard) and each is the canonical
 * address for its own "now", so a control that guessed wrong would silently move
 * a reader to the other page, and a default is exactly how the third one would
 * inherit the wrong guess.
 */
export function SeasonPick({
  options,
  selectedId,
  basePath,
}: {
  /** Active season first, then the member's past terms, newest first. */
  options: HistorySeason[];
  /** The season being shown — the active one on the bare path. */
  selectedId: string | null;
  /** The screen this control belongs to, e.g. `/my-stats`. No trailing slash. */
  basePath: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  if (options.length < 2) return null;

  function choose(id: string) {
    const chosen = options.find((s) => s.id === id);
    if (!chosen) return;
    const next = new URLSearchParams(searchParams?.toString() ?? '');
    if (chosen.active_flag) next.delete('season');
    else next.set('season', chosen.id);
    const qs = next.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath);
  }

  return (
    <label className="season-pick">
      <span className="season-pick-label">SEASON</span>
      <select
        className="season-pick-select"
        value={selectedId ?? ''}
        onChange={(e) => choose(e.target.value)}
        aria-label="Which season to show"
      >
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.active_flag ? ' · now' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

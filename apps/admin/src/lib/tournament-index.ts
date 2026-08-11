import { isDoublesEvent } from '@badminton/shared';

// THE /tournaments INDEX, derived rather than stored.
//
// Everything here answers a question the schema does not have a column for, and
// each answer is built only out of columns that exist. The rule this file was
// written under: if the source is not in supabase/migrations, the number does
// not get rendered. Two things the index mockup asked for had no source at all
// (an entry deadline, a tournament-level export) and are simply absent.

/** One tournament_events row, in the shape the index needs. */
export type IndexEvent = {
  id: string;
  tournament_id: string;
  event_type: string;
  status: string;
  draw_locked: boolean | null;
  max_participants: number | null;
};

/**
 * The row's headline state.
 *
 * `tournaments.status` is only draft | active | completed | archived (00001
 * schema, line 96) — it cannot say whether entries are open or the draw is up,
 * because that lives on the CHILD events (`tournament_events.status`,
 * `draw_locked`). So the badge is a fold of the parent status and the children,
 * and the order below is the precedence:
 *
 *  - suspended beats everything: `tournaments.suspended_at` (00009) stops the
 *    tournament dead, whatever its events say.
 *  - the parent's own terminal states (archived, completed) beat the children,
 *    because an archived tournament with an event still marked `registration`
 *    is filed away, not open.
 *  - then the children, most-advanced-wins: one event with a bracket up makes
 *    the tournament "draw set" even if a second is still taking entries, since
 *    the job in front of the officer is running that draw.
 */
export type TournamentStage =
  | 'suspended'
  | 'archived'
  | 'finished'
  | 'draw-set'
  | 'entries-open'
  | 'no-events';

export function tournamentStage(
  tournament: { status: string; suspended_at?: string | null },
  events: IndexEvent[],
): TournamentStage {
  if (tournament.suspended_at) return 'suspended';
  if (tournament.status === 'archived') return 'archived';
  if (tournament.status === 'completed') return 'finished';
  if (events.length === 0) return 'no-events';
  if (events.some((e) => e.status === 'bracket_generated' || e.status === 'live' || e.draw_locked)) {
    return 'draw-set';
  }
  if (events.some((e) => e.status === 'registration' || e.status === 'checkin')) {
    return 'entries-open';
  }
  // Every event is `completed` while the tournament row still says active —
  // the day is over and nobody has pressed the parent's Complete button.
  return 'finished';
}

export const STAGE_LABEL: Record<TournamentStage, string> = {
  suspended: 'SUSPENDED',
  archived: 'ARCHIVED',
  finished: 'FINISHED',
  'draw-set': 'DRAW SET',
  'entries-open': 'ENTRIES OPEN',
  'no-events': 'NO EVENTS',
};

// success / warning / danger / neutral only — the four the console's guidelines
// allow for a status. `info` and `default` exist on Badge and are not statuses.
export const STAGE_BADGE: Record<TournamentStage, 'success' | 'warning' | 'danger' | 'neutral'> = {
  suspended: 'danger',
  archived: 'neutral',
  finished: 'neutral',
  'draw-set': 'warning',
  'entries-open': 'success',
  'no-events': 'neutral',
};

/** The next job on this tournament, as the label of the link into it. */
export const STAGE_ACTION: Record<TournamentStage, string> = {
  suspended: 'Open',
  archived: 'Results',
  finished: 'Results',
  'draw-set': 'Run event',
  'entries-open': 'Seed draw',
  'no-events': 'Add events',
};

/**
 * The entries denominator, or null when there isn't one.
 *
 * `tournament_events.max_participants` is a REAL cap and a nullable one: the
 * insert paths refuse a registration past it (lib/tournament-actions/
 * participants.ts) and bracket generation uses it as the field size. But it
 * lives on the event and a row here is a TOURNAMENT, so the only honest total
 * is the sum — and only when every event carries a cap. One uncapped event and
 * the sum understates the room available, which would render "26/32" for a
 * tournament that can take an unlimited number more. In that case there is no
 * denominator, so none is shown: a bare count, no bar.
 */
export function capacityOf(events: IndexEvent[]): number | null {
  if (events.length === 0) return null;
  if (events.some((e) => e.max_participants == null)) return null;
  return events.reduce((sum, e) => sum + (e.max_participants ?? 0), 0);
}

/** "SINGLES + DOUBLES" — which disciplines this tournament actually runs. */
export function disciplineLine(events: IndexEvent[]): string {
  const singles = events.some((e) => !isDoublesEvent(e.event_type));
  const doubles = events.some((e) => isDoublesEvent(e.event_type));
  const parts: string[] = [];
  if (singles) parts.push('SINGLES');
  if (doubles) parts.push('DOUBLES');
  return parts.join(' + ');
}

/**
 * "Sat 7 Feb" from a Postgres DATE.
 *
 * Deliberately not shared/formatDate: that one produces "Feb 7, 2026" and, more
 * importantly, feeds a bare 'YYYY-MM-DD' to `new Date()`, which parses it as UTC
 * midnight and then renders it in the local zone — west of Greenwich that is the
 * previous day. A start date must never drift, so the parts are read straight
 * off the string and formatted in UTC.
 */
export function formatEventDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** Whole dollars, for the stat strip. Cents are for the fee roster, not a headline. */
export function formatDollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

/**
 * The fee a tournament charges, as a single string, or null when it charges
 * nothing anyone has written down.
 *
 * `tournament_fee_tiers` exists so a tournament can price member and guest
 * differently, so there is often no single number — a range is the truthful
 * answer, and one tier is just a range of width zero.
 */
export function feeLabel(tiers: { amount_cents: number }[]): string | null {
  if (tiers.length === 0) return null;
  const amounts = tiers.map((t) => t.amount_cents);
  const lo = Math.min(...amounts);
  const hi = Math.max(...amounts);
  return lo === hi ? formatDollars(lo) : `${formatDollars(lo)}–${formatDollars(hi)}`;
}

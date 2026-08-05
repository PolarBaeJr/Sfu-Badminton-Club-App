// When a tournament counts as finished.
//
// Feedback used to be collectable the moment a tournament page existed — a
// member could rate an event that had not started. Rating something you have
// not attended is not feedback, and it quietly poisons the exec team's only
// signal about how an event actually went.
//
// Two independent conditions, either of which is enough:
//
//   * an admin marked it completed/archived — the explicit signal, and the one
//     that lets an event be closed early;
//   * its last day has passed — the fallback, because "mark the tournament
//     completed" is exactly the housekeeping step that gets forgotten, and
//     feedback should not be blocked on an admin remembering.
//
// end_date is nullable; a single-day tournament only carries start_date, so
// fall back to that rather than treating a missing end as "never ends".

const FINISHED_STATUSES = new Set(['completed', 'archived']);

export interface TournamentWindowInput {
  status?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

export function hasTournamentEnded(
  tournament: TournamentWindowInput | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!tournament) return false;
  if (tournament.status && FINISHED_STATUSES.has(tournament.status)) return true;

  const last = tournament.end_date || tournament.start_date;
  if (!last) return false;

  // Dates are club-local calendar days (DATE columns), not instants. Compare on
  // the calendar day so the event stays "on" for the whole of its final day
  // regardless of the viewer's timezone — parsing "2026-08-05" as an instant
  // would end the event at midnight UTC, i.e. 5pm the previous afternoon here.
  const today = toIsoDay(now);
  return last < today;
}

function toIsoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

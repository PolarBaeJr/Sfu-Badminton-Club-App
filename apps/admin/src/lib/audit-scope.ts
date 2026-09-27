// WHAT WINDOW OF TIME THE AUDIT TRAIL IS SHOWING, decided once.
//
// This used to live inside app/audit/page.tsx, which was correct while the page
// was the only thing that asked. It is not any more: /api/audit/export answers
// the same question for the same `?season=` and `?range=` parameters, and the
// file it produces is read side by side with the screen it was downloaded from.
// Two copies of a timezone bound is EXACTLY the defect recorded below, so both
// callers resolve the window here and neither does any date arithmetic of its
// own.
//
// AND IT RESOLVES THE SEASON TOO, not just the bounds. Handing the route the
// raw `?season=` string and letting it call resolveSeasonScope for itself would
// leave the two halves able to disagree about WHICH season is selected while
// agreeing perfectly about how to convert its dates. The page and the download
// would then be scoped to different terms, with the same label on both, which
// is the original bug wearing a different coat.

import { resolveSeasonScope, type ScopeSeason } from '@/components/season-scope';
import { clubToday, wallClockToUtc } from '@badminton/shared';

/**
 * Club-local midnight opening `date`, as a UTC instant.
 *
 * BOTH ENDS OF THIS FILTER WERE IN THE WRONG ZONE (F-022). The season's
 * start_date and end_date are DATE columns and mean club-local calendar days,
 * but created_at is a timestamptz: the start bound was pinned to UTC midnight
 * and the end bound was `new Date('YYYY-MM-DDT00:00:00')`, which parses in
 * whatever timezone the container happens to run in, and that is UTC in
 * production. Both therefore sat 7 hours ahead of the club's own midnight, so
 * every season's window opened and closed at 17:00 the previous afternoon.
 * Actions taken on the last evening of a season were filed under the next one.
 *
 * `offset` shifts by whole calendar days before the conversion, which is what
 * makes the end bound half-open: end_date means "this day inclusive", so the
 * filter runs up to (but not including) club-local midnight the morning after.
 */
export function clubDayStart(date: string, offset = 0): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return wallClockToUtc(y, m, d + offset, 0, 0).toISOString();
}

export interface AuditWindow {
  /** Every season, for the picker. The shared resolver's list, unchanged. */
  seasons: ScopeSeason[];
  /** The season the window came from, or null for full history and the fallback. */
  selectedSeason: ScopeSeason | null;
  /** Inclusive lower bound as a UTC instant, or null for no lower bound. */
  since: string | null;
  /** Exclusive upper bound as a UTC instant, or null for "up to now". */
  until: string | null;
  /** What to call this window on screen and in a filename. */
  scopeLabel: string;
}

/**
 * The window one set of URL parameters means.
 *
 * The seasons themselves are the navigation. An audit trail is read to answer
 * "what happened during X", where X is a term, a tournament or a season
 * somebody is querying, and a rolling 30-day window cannot answer that question
 * at all: it silently ends mid-season and has no relationship to anything the
 * club recognises.
 *
 * Two overrides sit on top of the shared season resolution, both specific to a
 * log.
 *
 * `?range=all` is the escape hatch. An audit trail is the one page where
 * "before any season we still have" is a real question, so no season at all is
 * a legitimate scope here in a way it is not on a fee ledger.
 *
 * And a club activates the NEXT season before it starts, which is the normal
 * way to line one up. Defaulting to it would show an empty page: the window
 * opens in the future, so nothing that has already happened is inside it. An
 * explicit `?season=` is still honoured either way. Picking a season that has
 * not started and being shown nothing is a correct answer to a question
 * somebody asked; being shown nothing on arrival is not.
 */
export function resolveAuditWindow(
  seasons: ScopeSeason[] | null | undefined,
  seasonParam: string | undefined,
  fullHistory: boolean,
): AuditWindow {
  const { seasons: allSeasons, selected: scopeSeason } = resolveSeasonScope(seasons, seasonParam);

  // The club's today. toLocaleDateString with no timeZone reads the HOST zone
  // and the containers run UTC, so on a club evening it would call a season
  // that starts tomorrow "already started" and stop defaulting to full history.
  const today = clubToday();
  const impliedAndUnstarted =
    !seasonParam && !!scopeSeason?.start_date && scopeSeason.start_date > today;
  const selectedSeason = fullHistory || impliedAndUnstarted ? null : scopeSeason;

  if (fullHistory) {
    return { seasons: allSeasons, selectedSeason: null, since: null, until: null, scopeLabel: 'Full history' };
  }

  if (selectedSeason) {
    // start_date is nullable, and the string-template form this replaced hid
    // that: a null interpolated to the literal `nullT00:00:00Z`, which
    // PostgREST rejects, so the filter silently became "no rows" rather than
    // "no lower bound". A season without a start simply has no lower bound.
    //
    // An unfinished season has no end: everything since it started, up to now.
    return {
      seasons: allSeasons,
      selectedSeason,
      since: selectedSeason.start_date ? clubDayStart(selectedSeason.start_date) : null,
      until: selectedSeason.end_date ? clubDayStart(selectedSeason.end_date, 1) : null,
      scopeLabel: selectedSeason.name,
    };
  }

  // No season to scope by: none active, or the active one has not started.
  // Falling back to a window keeps the page useful instead of empty, and the
  // label says which one so it cannot be mistaken for a season.
  return {
    seasons: allSeasons,
    selectedSeason: null,
    since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    until: null,
    scopeLabel: 'Last 30 days',
  };
}

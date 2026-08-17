// "Is the club playing a tournament RIGHT NOW", for the feed's banner.
//
// Lives here rather than in packages/shared for the same reason feed-activity.ts
// and tournament-index.ts do: these are the shapes one screen needs, and they
// take `todayKey` as an argument rather than reading the clock, so "active" can
// be tested rather than hoped for.
//
// NOT A SECOND COPY OF tournament-index.ts. That module answers a different
// question — "what can I ENTER" — and leads /tournaments with it
// (pickHeroTournament filters on `status === 'registration'`). This one answers
// the opposite: registration is over, the draw is out, people are on court. The
// two allow-lists are disjoint on purpose, so the feed never advertises as
// "under way" the same event /tournaments is advertising as "entries open".
//
// What IS shared: occupiesAPlace and countEnteredPlayers are imported from
// there rather than re-implemented, so "you are in" on the feed and "You are in"
// on /tournaments cannot disagree about the same member.

import type { TournamentEventStatus, TournamentEventType } from '@badminton/shared';

export type FeedEvent = {
  id: string;
  event_type: TournamentEventType;
  status: string;
};

export type FeedTournament = {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  tournament_events: FeedEvent[];
};

/**
 * An event that is neither still taking entries nor finished.
 *
 * A DENY-LIST, NOT AN ALLOW-LIST, and 00107 is the reason. The CHECK in 00001
 * had five statuses; 00107 added `pool_generated` and `pool_live` for the
 * pool-to-bracket format. An allow-list written against the 00001 five would
 * have silently stopped recognising a whole event format as running — the card
 * would just never appear for it, which is the failure mode this repo keeps
 * losing screens to. Naming the two ENDS instead means a status added in the
 * middle of the lifecycle is treated as running by default.
 *
 * The cost of that choice, written down because somebody will hit it: a future
 * TERMINAL status (a hypothetical 'cancelled' or 'abandoned') has to be added
 * here, or the card will call it "under way" forever.
 */
export function isRunningEvent(event: FeedEvent): boolean {
  return event.status !== 'registration' && event.status !== 'completed';
}

/** Drawn or being played, as opposed to merely open for check-in. This is what
 *  separates "get to your court" from "come and get your name ticked off". */
export function isPlayingEvent(event: FeedEvent): boolean {
  return (
    event.status === 'pool_generated' ||
    event.status === 'pool_live' ||
    event.status === 'bracket_generated' ||
    event.status === 'live'
  );
}

/**
 * The last club day this tournament can still be called "on".
 *
 * `end_date` is nullable and the admin's own create/edit form lets an exec leave
 * it blank (apps/admin/src/app/tournaments/actions.tsx sends `end_date ||
 * undefined`), so `start_date` is the fallback. That errs toward hiding the card
 * on day two of an undated multi-day tournament, which is the safe direction:
 * showing nothing is a smaller lie than "HAPPENING NOW" over something that
 * finished.
 */
export function lastDayOf(t: { start_date: string; end_date: string | null }): string {
  return (t.end_date ?? t.start_date).slice(0, 10);
}

/**
 * ON RIGHT NOW — the definition, and it is a date bound as much as a status one.
 *
 * *** THE DATE BOUND IS THE LOAD-BEARING HALF, AND PRODUCTION PROVES IT. ***
 * The status columns alone are not enough, because nothing ever walks an event
 * back to `completed` when the gym empties. As of 2026-08-17 production holds
 * exactly one tournament, and it is this exact trap:
 *
 *     Test Competition 1 | status=active | start=end=2026-07-24 | not suspended
 *     events: mens_singles=completed, open_singles=completed, womens_singles=LIVE
 *
 * It is in the ACTIVE season, it is `status='active'`, it is not suspended, and
 * one of its events has been sitting at `live` for over three weeks. A card
 * keyed on status alone would say "HAPPENING NOW" on every member's landing
 * screen today, for a tournament that ended last month — which is the precise
 * thing this must not do. `todayKey <= lastDayOf(t)` is what kills it.
 *
 * The comparison is a STRING compare, not a Date one. `start_date` and
 * `end_date` are Postgres DATEs and arrive as "YYYY-MM-DD", the same shape
 * clubDayKey returns, and both sort correctly as plain strings. isUpcoming() in
 * tournament-index.ts carries the long-form version of why that matters: parsing
 * a DATE with `new Date()` reads it as UTC midnight, so from ~16:00 Vancouver
 * today's tournament read as already over.
 *
 * `>=` is inclusive, so the card survives the whole of the final day.
 * apps/admin/src/app/audit/page.tsx documents end_date as "this day inclusive".
 *
 * NOT CHECKED HERE, because the QUERY does it and doing it twice invites drift:
 * tournaments.status = 'active', suspended_at IS NULL, and the active-season
 * scope. See the call site in app/feed/page.tsx.
 */
export function isUnderWay(t: FeedTournament, todayKey: string): boolean {
  if (lastDayOf(t) < todayKey) return false;
  return (t.tournament_events ?? []).some(isRunningEvent);
}

/** The events of a running tournament that are actually running. Ordered as the
 *  query returned them; the caller does not re-sort, because an exec's event
 *  order is the running order. */
export function runningEvents(t: FeedTournament): FeedEvent[] {
  return (t.tournament_events ?? []).filter(isRunningEvent);
}

/**
 * The word at the top of the card.
 *
 * Two states rather than one, because they ask the member for different things.
 * "UNDER WAY" means a draw exists and there are courts to be at; "CHECK-IN OPEN"
 * means the desk is taking names and nothing has been drawn yet. A single label
 * covering both would send somebody looking for a court that does not exist.
 */
export function underWayEyebrow(events: FeedEvent[]): 'UNDER WAY' | 'CHECK-IN OPEN' {
  return events.some(isPlayingEvent) ? 'UNDER WAY' : 'CHECK-IN OPEN';
}

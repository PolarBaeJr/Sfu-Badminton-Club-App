import { PUBLIC_TRACKS, visibleTracksFor } from '@badminton/shared';

// THE ONLY PLACE IN THIS APP THAT NAMES THE `track` COLUMN IN A FILTER.
//
// visibleTracksFor() decides WHICH tracks a member sees, and on its own that is
// only half the guard: a helper anybody may ignore does not stop a seventh call
// site from hand-writing `.in('track', [player.status, 'all'])` and
// reintroducing the outage it was written to end. Six call sites had already
// done exactly that, independently, in three different files.
//
// So the literal lives here, once. `session-track-filter.test.ts` greps
// apps/player/src for `.in('track'` and asserts a single occurrence — this one
// — which turns "all six go through the mapping" from a thing somebody has to
// remember into a thing the suite fails over.
//
// Shaped like `inActiveSeason` in sessions/page.tsx and feed/page.tsx: a
// structural type over the one method it calls, so it composes with a
// half-built PostgREST query without importing supabase-js types into a module
// that has no other reason to know them.
//
// WHY THE `.in` IS REACHED THROUGH A CAST INSTEAD OF A STRUCTURAL CONSTRAINT,
// which is the one thing in this file that looks like a shortcut and is not.
//
// `inActiveSeason`'s spelling — `<T extends { or: (f: string) => T }>` — works
// there because `or` takes a plain string. `in` does not. PostgREST types it as
//
//     in<ColumnName extends string & keyof Row>(
//       column: ColumnName, values: ReadonlyArray<Row[ColumnName]>): this
//
// so ANY structural bound mentioning `in` makes the compiler match a generic,
// `this`-returning method against the generated `Database` row types. On the
// calendar route — the service-role client, where the builder carries the full
// generic payload — that is "Type instantiation is excessively deep and
// possibly infinite", and it fails `next build` rather than merely being slow.
// Both the self-referential bound and the return-only variant were tried and
// both blew up there.
//
// Inferring T straight from the argument leaves nothing to solve, and the cast
// is confined to this one line. What it costs is the compile-time check that
// the argument really is a query builder — which is why the behaviour of this
// function is covered by a test that stubs a builder faithfully enough to
// REJECT an out-of-vocabulary enum value, rather than by the type system.
//
// STILL EXACTLY ONE `.in` ON THIS COLUMN, which is what the grep test counts.
// onTracks is the single filter; the two functions below choose the vocabulary
// and delegate. Adding a second `.in('track'` here — even inside this file —
// would fail session-track-filter.test.ts, so a third audience has to come
// through onTracks too rather than hand-rolling a filter beside it.
function onTracks<T>(query: T, tracks: readonly string[]): T {
  const filterable = query as { in(column: string, values: readonly string[]): T };
  return filterable.in('track', tracks);
}

/** What a signed-in member sees: their own track plus club-wide nights. */
export function onVisibleTracks<T>(query: T, status: string | null | undefined): T {
  return onTracks(query, visibleTracksFor(status));
}

/**
 * What a viewer with no app account sees: club-wide nights only.
 *
 * Used by the Discord bot for an unlinked caller. session-track.ts carries the
 * reasoning on PUBLIC_TRACKS — in short, the "narrowing withholds nothing"
 * argument behind the untracked-member default is scoped to `authenticated`,
 * and an unlinked Discord user is not.
 */
export function onPublicTracks<T>(query: T): T {
  return onTracks(query, PUBLIC_TRACKS);
}

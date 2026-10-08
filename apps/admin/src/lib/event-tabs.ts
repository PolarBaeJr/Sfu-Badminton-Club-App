// WHEN THE RESULTS TAB EXISTS — asked in one place, by both of the two files
// that have to agree about it.
//
// The event page fetches `platform_settings.tournament_bonuses` for exactly one
// consumer, the Results tab, and that tab is only in EventControlCenter's list
// at `completed`. It used to be fetched on every load regardless, which was a
// round trip for a value nothing on screen could render.
//
// Making the fetch conditional put the same condition in two files, and two
// copies of a rule drift. If a later change gives Results a second status, the
// tab would appear with `bonusSettings` null and simply not render — a blank
// panel with no error anywhere. One predicate, imported by both, cannot do that.
//
// NOT a capability test, deliberately. The obvious key would be `platform.page`,
// and no exec holds it: gating on it would take the Results tab away from every
// exec in the club. This is about whether anything NEEDS the value, not about
// who may see it.

/** The one event status with a Results tab. */
export function hasResultsTab(status: string): boolean {
  return status === 'completed';
}

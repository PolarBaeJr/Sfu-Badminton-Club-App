import { Card } from '@badminton/ui';
import {
  buildRunningAreaPath,
  buildRunningPath,
  buildRunningTotal,
  computeRunningScale,
} from '@/lib/charts';
import { ChartNote, MICRO, RUNNING_BOX, RunningTotalChart, clubDayOf } from '@/components/charts';

/**
 * WHEN THE CLUB'S PRIVILEGED ACTIONS ACTUALLY HAPPENED.
 *
 * THE QUESTION: an audit trail is read to answer "what happened around X" — the
 * week a member was banned, the day the fees were rewritten — and this screen
 * could only answer it by scrolling. The table is chronological but shows one
 * page of rows at a time; nothing on it says the term was quiet for a month and
 * then had forty actions in three days. A cumulative line says exactly that: a
 * flat run is a quiet stretch, a steep riser is a burst, and the reader clicks
 * into the table at the date the shape points at.
 *
 * NOT THE DISTRIBUTION BY ACTION GROUP, which was the other obvious candidate
 * and is already on the screen. buildTabs() in @/lib/audit-log-view derives the
 * tab set from these same rows and prints each group's count in its tab label —
 * Members 12, Money 4, and so on, summing to All exactly. A bar chart of those
 * seven numbers would be the tab bar drawn twice, and the house rule is that a
 * chart must not restate a figure already on screen. The taxonomy is not
 * reimplemented here for the same reason it is not duplicated there: there is
 * one groupOf() and this panel does not need a second one.
 *
 * A STEP, AND WHY THAT MATTERS MORE HERE THAN ON A LEDGER. buildRunningPath
 * refuses to slope between two dated days, and an audit log is the clearest
 * case for that refusal: nothing at all happened on the days between two
 * entries, and a diagonal would draw a club steadily doing administration
 * through a week nobody touched the console.
 *
 * ---- WHAT IT REFUSES TO DRAW -------------------------------------------------
 *
 * computeRunningScale returns NULL below two dated days, so a scope holding one
 * day of activity — or none — gets a sentence instead of an axis. That is a
 * live case here rather than a theoretical one: the page falls back to a
 * 30-day window when no season is in scope, and a quiet club can easily put
 * every row in that window on one day. The floor is pinned at zero and the
 * series only ever rises, so the unsigned scale is the right one; a running
 * count of things that have happened cannot go backwards.
 *
 * ---- COST AND CAPABILITY -----------------------------------------------------
 *
 * NO QUERY. The page has already fetched these rows under `audit.page` and
 * capped them at 500 for a season or 1000 for full history; this panel folds
 * the array it was handed and reads nothing else. It takes only `created_at` —
 * not the actor, not the reason, not the subject — so nothing this draws could
 * disclose a name the table beside it does not already show.
 *
 * ---- WHY IT IS NOT INSIDE AuditList ------------------------------------------
 *
 * AuditList is a client component owning the tab, search and sort state, and
 * this chart is deliberately over the UNFILTERED scope: it is the shape of the
 * whole term, which is what makes it navigation. Rendering it inside that
 * component would ship the drawing code to the browser for a picture that never
 * changes, and — worse — would sit it underneath a filter it does not obey. So
 * it is a server component above the list, and the heading names the scope so
 * it cannot be mistaken for a view of the filtered rows.
 */

/** Only the column this panel reads. */
export interface ActivityRow {
  created_at: string;
}

export function AuditActivityChart({
  logs,
  scopeLabel,
}: {
  logs: readonly ActivityRow[];
  /** "Fall 2026", "Last 30 days", "Full history" — the page's own words. */
  scopeLabel: string;
}) {
  // One per row: the series counts ACTIONS, so every entry weighs the same.
  // `cents` is the Payment field name and holds a count of one here — the
  // builder is unit-agnostic and named for its commonest caller.
  //
  // Bucketed by CLUB-LOCAL day, not by `created_at.slice(0, 10)`. An action
  // taken at 19:00 in Vancouver is already tomorrow in UTC, so slicing the
  // string would file half the club's evening administration under the next
  // day — and on a chart whose entire subject is which day things happened,
  // that is the one error that cannot be shrugged off.
  const points = buildRunningTotal(
    logs.map((log) => ({ at: log.created_at, cents: 1 })),
    clubDayOf,
  );
  const scale = computeRunningScale(points, RUNNING_BOX);

  return (
    <Card padding={false}>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <h2 className={MICRO}>Activity</h2>
        <span className={MICRO}>{scopeLabel}</span>
      </div>
      <div className="px-4 py-4">
        {scale === null ? (
          <ChartNote>
            {points.length === 0
              ? 'Nothing was recorded in this scope. Every privileged action the console takes appears here.'
              : 'Everything in this scope happened on one day, so there is no run to draw. The entries are in the table below.'}
          </ChartNote>
        ) : (
          <RunningTotalChart
            points={points}
            scale={scale}
            linePath={buildRunningPath(points, scale)}
            areaPath={buildRunningAreaPath(points, scale)}
            tone="var(--color-info)"
            label={`Recorded actions across ${scopeLabel}, accumulating from the first to the last.`}
            noun={['action', 'actions']}
          />
        )}
      </div>
    </Card>
  );
}

import { Card } from '@badminton/ui';
import {
  buildRunningAreaPath,
  buildRunningPath,
  buildRunningTotal,
  computeSignedRunningScale,
} from '@/lib/charts';
import type { SeasonFinances } from '@/lib/season-finance';
import { ChartNote, RUNNING_BOX, RunningTotalChart, clubDayOf, money } from '@/components/charts';
import { CardHeading } from './card-heading';

/**
 * "ARE WE IN THE POSITIVES?" — ACROSS THE TERM, NOT JUST TODAY.
 *
 * The strip above already answers the question for this instant: in, out, net.
 * What it cannot say is WHEN the answer changed, and that is the half an
 * officer acts on — a club that is $40 up having been $600 down in October is
 * in a different position from one that has been drifting down all term, and
 * the two print the same three figures.
 *
 * BEHIND `fees.netposition.read` AND NOTHING WEAKER. This is the only
 * capability that may read every book, which is what makes a figure spanning
 * all of them drawable at all. It adds no query: the dated rows behind both
 * halves were already fetched for the totals, and getSeasonFinances signs and
 * merges them (see `netPayments`).
 *
 * IT DISCLOSES NO INDIVIDUAL LEDGER. The series is untagged — dated money with
 * a sign — so a holder of this capability sees the club's net over time and
 * cannot recover the tournament ledger or the reinstatement ledger from it,
 * either of which is somebody else's book.
 *
 * THE CURVE NEEDS A SIGNED SCALE, and that is why one was added to the kit.
 * computeRunningScale pins its floor at zero and clamps, so every negative day
 * would land exactly on the baseline and a term spent underwater would draw as
 * a flat line reading "the club broke even all term". See
 * computeSignedRunningScale.
 */
export function NetPositionChart({
  finances,
  seasonName,
}: {
  finances: SeasonFinances;
  seasonName: string;
}) {
  const points = buildRunningTotal(finances.netPayments, clubDayOf);
  const scale = computeSignedRunningScale(points, RUNNING_BOX);
  const inTheRed = finances.netCents < 0;
  // The tone is taken from where the club ENDED UP, matching the Net cell in
  // the strip above. A curve that crossed zero is one colour either way — two
  // would need a gradient or a split path, and the console has neither; the
  // zero rule the line crosses is what carries that story, and the figure
  // beside it says which side today is on.
  const tone = inTheRed ? 'var(--color-danger)' : 'var(--color-success)';

  // THE LOW POINT IS WORTH NAMING. It is the thing a reader reaches for once
  // they can see the shape ("how bad did it get"), and reading it off a curve
  // whose axis is deliberately unlabelled is guesswork. Taken from the plotted
  // points, so it is a day the club actually had.
  const trough = points.reduce(
    (low, p) => (p.cents < low.cents ? p : low),
    points[0] ?? { day: '', cents: 0, count: 0 },
  );

  return (
    <Card padding={false}>
      <CardHeading
        title="Across the term"
        sub={`Everything in and out of ${seasonName}, day by day, as one running figure.`}
      />
      <div className="px-4 py-4">
        {scale ? (
          <div className="space-y-3">
            <RunningTotalChart
              points={points}
              scale={scale}
              linePath={buildRunningPath(points, scale)}
              areaPath={buildRunningAreaPath(points, scale)}
              tone={tone}
              noun={['transaction', 'transactions']}
              label={`Net position for ${seasonName}: ${inTheRed ? 'minus ' : ''}${money(
                finances.netCents,
              )} after ${points.length} days of money in and out.`}
            />
            {/* The zero rule is drawn by RunningTotalChart at y(0) and is the
                only reference line on the chart, so it is worth saying what it
                is. Without this the reader has a line and no legend for it. */}
            <p className="text-xs text-[var(--text-muted)]">
              The rule is break-even. Below it the club has spent more than it has taken in.
              {trough.cents < 0 &&
                ` The lowest point was ${money(trough.cents)} in the red.`}
            </p>
          </div>
        ) : (
          <ChartNote>
            {finances.netPayments.length === 0
              ? `Nothing has been recorded against ${seasonName} yet, so there is no position to plot.`
              : 'Every payment so far landed on one day, so there is no line to draw yet. A running total needs two.'}
          </ChartNote>
        )}
      </div>
    </Card>
  );
}

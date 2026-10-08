import Link from 'next/link';
import { Card } from '@badminton/ui';
import { buildHistogram } from '@/lib/charts';
import type { LadderSpread } from '@/lib/dashboard-ladder';
import { ChartNote, HistogramChart, MICRO } from '@/components/charts';

/**
 * THE SHAPE OF THE CLUB'S LADDER — the panel behind `players.read`.
 *
 * Composed from the same primitives as the money panels and knowing nothing
 * about them: a histogram, its axis, and a sentence when there is nothing to
 * draw. See @/components/charts for the shapes and @/lib/dashboard-ladder for
 * why this capability and not `ratings.page`.
 *
 * TWO HISTOGRAMS, NEVER ONE. A singles rating and a doubles rating are
 * different numbers on different scales — the player app's rating chart splits
 * them for the same reason — so putting both in one set of bins would invent a
 * combined ladder nobody plays on. Each gets its own range and its own axis.
 */
const BINS = 14;

const SECTION =
  'font-[family-name:var(--display)] text-[13px] font-bold uppercase tracking-[0.12em] text-[var(--ink)]';

export function LadderPanel({ spread }: { spread: LadderSpread }) {
  const singles = buildHistogram(spread.singles, BINS);
  const doubles = buildHistogram(spread.doubles, BINS);
  const provisional = spread.singlesProvisional + spread.doublesProvisional;
  const nothingRated = singles.total === 0 && doubles.total === 0;

  return (
    <Card padding={false}>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <h2 className={SECTION}>Ladder spread</h2>
        {/* Said, not drawn. A provisional rating is still settling, so it is
            kept out of the bins — and a chart that silently showed a smaller
            club would be worse than one that explains the gap. */}
        {provisional > 0 && <span className={MICRO}>{provisional} still settling</span>}
      </div>
      <div className="space-y-5 px-4 py-4">
        {nothingRated ? (
          <ChartNote>
            No member has a settled rating yet. Ratings firm up after a few confirmed matches,
            and the spread of the club appears here once they do.
          </ChartNote>
        ) : (
          <Link href="/players" className="block space-y-5">
            <Discipline label="Singles" histogram={singles} />
            <Discipline label="Doubles" histogram={doubles} />
          </Link>
        )}
      </div>
    </Card>
  );
}

function Discipline({
  label,
  histogram,
}: {
  label: string;
  histogram: ReturnType<typeof buildHistogram>;
}) {
  return (
    <div className="space-y-2">
      <p className={MICRO}>{label}</p>
      {histogram.total === 0 ? (
        <ChartNote>Nobody has a settled {label.toLowerCase()} rating yet.</ChartNote>
      ) : (
        <HistogramChart
          histogram={histogram}
          tone="var(--color-info)"
          height={72}
          label={`rated ${histogram.total === 1 ? 'member' : 'members'}`}
          format={(v) => String(Math.round(v))}
        />
      )}
    </div>
  );
}

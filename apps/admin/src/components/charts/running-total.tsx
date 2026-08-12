import type { CumulativePoint, RunningScale } from '@/lib/charts';
import { MICRO, chartDay } from './figures';

/**
 * A RUNNING TOTAL ACROSS A TERM — the one shape here that needs SVG.
 *
 * TAKES: points from buildRunningTotal(), a scale from computeRunningScale()
 * and the two paths from buildRunningPath() / buildRunningAreaPath(). The
 * caller computes them because they are pure and testable; this component only
 * draws.
 * AIMED AT: /fees and /seasons (money in or out across a term), /players (joins
 * across a term), /matches (matches logged across a season). Anything
 * cumulative and dated.
 * EMPTY: computeRunningScale returns NULL for fewer than two dated days, and
 * this component is never reached with nothing — the caller renders ChartNote
 * instead. One payment day stretched across the box would draw a flat line
 * reading "nothing happened all term" over a ledger where everything happened
 * at once, which is the specific lie this split refuses.
 * DOES NOT: smooth, interpolate or extend past the last real value.
 *
 * TWO TRAPS THE PLAYER APP'S CHARTS PAID FOR, both live here:
 *
 *   1. `preserveAspectRatio="none"` stretches the viewBox to the container, so
 *      ANY text inside the SVG would render at one size on a phone and another
 *      on a wide card. Every label is therefore HTML positioned in percentage
 *      coordinates derived from the same scale, and the SVG holds nothing but
 *      two paths. The height is set in CSS, not by the aspect ratio.
 *   2. `vector-effect="non-scaling-stroke"` fixes a stroke's WIDTH under that
 *      stretch and does NOT fix its dash pitch. So there is no dash in this SVG
 *      at all; the zero baseline is a CSS border, which keeps its pitch and its
 *      one device pixel at every width.
 */

/** The user-unit box a running total is drawn in. 320 ≈ a card's inner width at 390px. */
export const RUNNING_BOX = { width: 320, height: 96, padY: 8, padX: 2 } as const;

export function RunningTotalChart({
  points,
  scale,
  linePath,
  areaPath,
  tone,
  label,
}: {
  points: readonly CumulativePoint[];
  scale: RunningScale;
  linePath: string;
  areaPath: string;
  /** A CSS colour token. */
  tone: string;
  /** Read out to a screen reader in place of the drawing. */
  label: string;
}) {
  const last = points[points.length - 1]!;
  const paymentCount = points.reduce((n, p) => n + p.count, 0);
  const pctX = (x: number) => `${(x / RUNNING_BOX.width) * 100}%`;
  const pctY = (y: number) => `${(y / RUNNING_BOX.height) * 100}%`;

  return (
    <div>
      <div className="relative w-full" style={{ height: RUNNING_BOX.height }}>
        <svg
          className="block h-full w-full"
          viewBox={`0 0 ${RUNNING_BOX.width} ${RUNNING_BOX.height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
        >
          <path d={areaPath} fill={tone} opacity={0.1} />
          <path
            d={linePath}
            fill="none"
            stroke={tone}
            strokeWidth={2}
            // Square corners on a step. A rounded join would put a curve on the
            // moment the money arrived, which is the one thing the step shape
            // exists to say did not happen gradually.
            strokeLinejoin="miter"
            strokeLinecap="butt"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* The zero baseline, as a CSS border — see trap 2 above. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 border-t border-[var(--border)]"
          style={{ top: pctY(scale.y(0)) }}
        />

        {/* The end of the line, at a FIXED pixel size. An SVG <circle> under
            preserveAspectRatio="none" is an ellipse that grows with the card. */}
        <span
          aria-hidden
          className="pointer-events-none absolute h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: pctX(scale.x(last.day)),
            top: pctY(scale.y(last.cents)),
            background: tone,
          }}
        />
      </div>

      {/* The axis is the two days the series spans and how many entries are in
          it. A tick per day would be unreadable at this width, and the series is
          a set of days on which something happened rather than a continuous
          calendar — labelling it densely would imply a scale it does not have. */}
      <div className={`mt-2 flex items-baseline justify-between gap-2 ${MICRO}`}>
        <span>{chartDay(scale.firstDay)}</span>
        <span>
          {paymentCount} {paymentCount === 1 ? 'entry' : 'entries'}
        </span>
        <span>{chartDay(scale.lastDay)}</span>
      </div>
    </div>
  );
}

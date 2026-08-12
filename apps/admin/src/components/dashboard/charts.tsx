import { Atomic } from '@badminton/ui';
import { CLUB_TIMEZONE } from '@badminton/shared';
import type { BarRow, CumulativePoint, RunningScale } from '@/lib/dashboard-charts';

/**
 * THE DASHBOARD'S DRAWING PRIMITIVES. Area-agnostic on purpose.
 *
 * Nothing in this file knows about money, ledgers or capabilities: it takes
 * labelled parts and dated running totals and draws them. That is what makes a
 * second area's chart a data source plus a panel rather than a rewrite — see
 * the note at the top of ./finance-panels.tsx for what a sessions panel would
 * actually need.
 *
 * SERVER COMPONENTS, deliberately. Every one of these renders from props with
 * no state and no event handler, so marking them 'use client' would ship the
 * drawing code AND its data to the browser for a picture that never changes.
 * The dashboard is an async server component and these are rendered inside it.
 *
 * TWO TRAPS THE PLAYER APP'S CHARTS PAID FOR, both live here too:
 *
 *   1. `preserveAspectRatio="none"` stretches the viewBox to the container, so
 *      ANY text inside the SVG would render at one size on a phone and another
 *      on a wide card. Every label on these charts is therefore HTML positioned
 *      in percentage coordinates derived from the same scale, and the SVG holds
 *      nothing but paths.
 *   2. `vector-effect="non-scaling-stroke"` fixes a stroke's WIDTH under that
 *      stretch and does NOT fix its dash pitch. So there are no dashes in any
 *      SVG here; the zero baseline is a CSS border, which keeps its pitch at
 *      every width.
 */

/** Money, formatted the way every finance card in this console formats it. */
export const money = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(2)}`;

const MICRO =
  'font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]';

/** `22 JUL` — club-local, short enough for the end of an axis at 10px. */
export function chartDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  })
    // Noon UTC, and formatted in UTC: `day` is already a club-local calendar
    // date, so re-reading it through CLUB_TIMEZONE would shift it a second
    // time and print the day before for anything filed in the evening.
    .format(new Date(Date.UTC(y as number, (m as number) - 1, d as number, 12)))
    .toUpperCase();
}

/** The club-local calendar day of an instant — what buildRunningTotal buckets by. */
export const clubDayOf = (iso: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: CLUB_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));

/**
 * A HEADLINE FIGURE AND WHAT IT MEANS, in the console's money type.
 *
 * Mono, because it is a number a human compares against the ones under it.
 */
export function ChartFigure({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone?: string;
  sub?: string;
}) {
  return (
    <div>
      <p className={MICRO}>{label}</p>
      <p
        className="font-mono text-[28px] font-bold leading-none tracking-tight"
        style={{ color: tone ?? 'var(--text-primary)' }}
      >
        <Atomic>{value}</Atomic>
      </p>
      {sub && <p className="mt-2 text-xs text-[var(--text-muted)]">{sub}</p>}
    </div>
  );
}

/**
 * LABELLED BARS, EACH WITH ITS OWN FIGURE BESIDE IT.
 *
 * A bar without its number is decoration — the reader cannot recover a value
 * from a length, and on a two-row comparison they cannot even recover the
 * ratio reliably. So the figure is not a tooltip and not a legend: it is on the
 * row, in mono, at a size that reads on a phone.
 *
 * The track is a hairline BOX rather than a filled one. `--surface-2` resolves
 * to #fff in the light theme — the same value as the card underneath it — so a
 * surface-step track is invisible on every light-theme console, which is the
 * white-on-white failure the loading skeletons in globals.css already document.
 * `--border` is an alpha neutral and reads against #111 and #fff alike.
 *
 * A zero part draws no bar at all, on purpose. An empty track beside "$0.00" is
 * the truth; a minimum-width stub would be a shape standing for nothing.
 */
export function BarRows({
  rows,
  tone,
  format = money,
}: {
  rows: readonly BarRow[];
  /** A CSS colour token. One tone for the whole set — differentiation is the labels. */
  tone: string;
  format?: (cents: number) => string;
}) {
  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.label}>
          <div className="flex items-baseline justify-between gap-3">
            <span className={MICRO}>{row.label}</span>
            <span className="font-mono text-sm font-medium text-[var(--text-primary)]">
              <Atomic>{format(row.cents)}</Atomic>
            </span>
          </div>
          <div className="mt-1.5 h-2 w-full border border-[var(--border)]">
            <div
              className="h-full"
              style={{ width: `${row.pct}%`, background: tone }}
              aria-hidden
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The user-unit box every running total on this page is drawn in. */
export const RUNNING_BOX = { width: 320, height: 96, padY: 8, padX: 2 } as const;

/**
 * A RUNNING TOTAL ACROSS THE TERM.
 *
 * `scale` is null when there are fewer than two payment days, and the caller
 * renders words instead of calling this — see computeRunningScale. Nothing in
 * here can draw an empty axis, because it is never reached with nothing to
 * draw.
 */
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
            // Square corners on a step. A rounded join would put a curve on
            // the moment the money arrived, which is the one thing the step
            // shape exists to say did not happen gradually.
            strokeLinejoin="miter"
            strokeLinecap="butt"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* The zero baseline, as a CSS border rather than an SVG line: see the
            dash-pitch note at the top of this file, and it also guarantees the
            floor is exactly one device pixel at any container width. */}
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

      {/* The axis is the two days the series spans and how many payments are in
          it. A tick per day would be unreadable at this width, and the series
          is a set of payment days rather than a continuous calendar — labelling
          it densely would imply a scale it does not have. */}
      <div className={`mt-2 flex items-baseline justify-between gap-2 ${MICRO}`}>
        <span>{chartDay(scale.firstDay)}</span>
        <span>
          {paymentCount} {paymentCount === 1 ? 'payment' : 'payments'}
        </span>
        <span>{chartDay(scale.lastDay)}</span>
      </div>
    </div>
  );
}

/**
 * WHAT AN EMPTY LEDGER SAYS.
 *
 * Not an axis with nothing on it, and not a card that quietly disappears. The
 * console's rule is that empty and withheld are different states and both are
 * said out loud; the player app's version of this line — "play a rated match to
 * start your chart" — is the register to match, because it tells the reader
 * what would put something here.
 */
export function ChartNote({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-[var(--text-muted)]">{children}</p>;
}

import { Atomic } from '@badminton/ui';
import type { BarRow, Column, Histogram, Split } from '@/lib/charts';
import { MICRO, money } from './figures';

/**
 * THE THREE SHAPES THAT NEED NO SVG: bar rows, columns and a split track.
 *
 * All three are plain HTML and CSS, which is not a shortcut — it is what keeps
 * their labels at a fixed size and their edges at one device pixel however wide
 * the card is. See ./running-total.tsx for the one shape that does need SVG and
 * the two traps that come with it.
 *
 * Read the header of ./figures.tsx for the house rules every one of these obeys
 * (mono figures, no new colours, alpha-neutral tracks, the figure always beside
 * the shape, an honest empty state rather than an empty axis).
 */

/**
 * LABELLED BARS, EACH WITH ITS OWN FIGURE BESIDE IT.
 *
 * TAKES: rows from buildBars() — label, value in `cents`, and a `pct` already
 * measured against the largest row.
 * AIMED AT: /fees (spend by category, income by ledger), /players (any
 * per-status comparison), /audit (actions by kind), and the dashboard's money
 * panels. Reach for it whenever the categories have no meaningful ORDER and
 * their sum is not a real quantity.
 * EMPTY: renders nothing at all for an empty row set — the caller says why.
 * A zero row draws an empty track beside "$0.00", which is the truth; a
 * minimum-width stub would be a shape standing for nothing.
 * DOES NOT: sort (the caller decides the reading order), stack, or colour rows
 * individually. One tone for the set — differentiation is the labels, because
 * five hues in a flat console is five new colour values.
 */
export function BarRows({
  rows,
  tone,
  format = money,
}: {
  rows: readonly BarRow[];
  /** A CSS colour token. One tone for the whole set. */
  tone: string;
  format?: (value: number) => string;
}) {
  if (rows.length === 0) return null;
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
            <div className="h-full" style={{ width: `${row.pct}%`, background: tone }} aria-hidden />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * COLUMNS IN A READING ORDER, WITH EVERY FIGURE ON ITS TICK.
 *
 * TAKES: columns from buildColumns() — a label, a value, an optional `under`
 * value stacked beneath it, and heights already measured against the tallest
 * total.
 * AIMED AT: /sessions (turnout per session across a term), /tournaments
 * (entries per event), /matches (results per week), /seasons. Reach for it
 * instead of BarRows whenever the ORDER of the categories carries meaning — a
 * run of dates, a bracket — because rows sorted largest-first destroy that.
 * EMPTY: nothing for an empty set; an all-zero set draws empty ticks with
 * their figures under them rather than a floor of stubs.
 * DOES NOT: draw a value axis. The figure is on the column, which is what the
 * reader actually needs, and a y axis on a six-column chart is furniture.
 *
 * The count sits ABOVE each column and the label below, both in HTML at a fixed
 * size, so a narrow card shrinks the columns and never the type.
 */
export function ColumnChart({
  columns,
  tone,
  underTone,
  format = String,
  height = 96,
}: {
  columns: readonly Column[];
  tone: string;
  /** The tone for the stacked `under` part. Required if any column has one. */
  underTone?: string;
  format?: (value: number) => string;
  height?: number;
}) {
  if (columns.length === 0) return null;
  return (
    <div className="flex items-end gap-2" style={{ minHeight: height + 34 }}>
      {columns.map((column) => (
        <div key={column.label} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
          <span className="font-mono text-[11px] font-medium text-[var(--text-primary)]">
            {format(column.value)}
          </span>
          {/* The track is a hairline BASELINE rather than a box: a column chart
              reads against the floor it stands on, and a full outline around
              every empty tick would out-weigh the data in it. */}
          <div
            className="flex w-full flex-col justify-end border-b border-[var(--border)]"
            style={{ height }}
          >
            <div style={{ height: `${column.pct}%`, background: tone }} aria-hidden />
            {column.under !== undefined && (
              <div
                style={{ height: `${column.underPct}%`, background: underTone ?? tone }}
                aria-hidden
              />
            )}
          </div>
          <span className={`${MICRO} truncate max-w-full`}>{column.label}</span>
          {column.note && <span className={`${MICRO} truncate max-w-full`}>{column.note}</span>}
        </div>
      ))}
    </div>
  );
}

/**
 * A DISTRIBUTION — the shape of a field of numbers.
 *
 * TAKES: a histogram from buildHistogram() — equal-width bins with counts and
 * range-compressed heights.
 * AIMED AT: /ratings and /players (how the club's ladder is spread), and any
 * other "what does the field look like" question. It is the right shape when
 * the x axis is a NUMBER RANGE rather than a set of categories.
 * EMPTY: nothing for an empty histogram. A distribution of nobody is not a flat
 * one, it is an absent one, and the caller says so.
 * DOES NOT: draw a mark per member. That was a real bug in the player app's
 * ladder — 1px rules across a 316px card beat into a moiré that read as empty
 * bands that were not empty. See buildHistogram's comment.
 *
 * The axis is the two ends of the range plus the population, which is all the
 * reader needs; per-bin edges at 10px across twelve bins are unreadable.
 */
export function HistogramChart({
  histogram,
  tone,
  height = 96,
  label,
  format = String,
}: {
  histogram: Histogram;
  tone: string;
  height?: number;
  /** What the population is called — "rated members". */
  label: string;
  format?: (value: number) => string;
}) {
  if (histogram.total === 0) return null;
  return (
    <div>
      <div className="flex items-end gap-[3px]" style={{ height }}>
        {histogram.bins.map((bin, i) => (
          <div
            key={i}
            className="flex-1"
            style={{ height: `${bin.pct}%`, background: tone, minHeight: bin.count > 0 ? 2 : 0 }}
            aria-hidden
          />
        ))}
      </div>
      <div className="mt-2 border-t border-[var(--border)] pt-2">
        <div className={`flex items-baseline justify-between gap-2 ${MICRO}`}>
          <span>{format(histogram.min)}</span>
          <span>
            {histogram.total} {label}
          </span>
          <span>{format(histogram.max)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * PART OF A WHOLE — one track, divided.
 *
 * TAKES: a split from buildSplit(), whose segments sum to 100 and whose total
 * is computed from the parts.
 * AIMED AT: /fees (collected against outstanding), /matches (confirmed against
 * pending against disputed), /players (active against the roster), /sessions
 * (turned up against did not).
 * EMPTY: a zero total draws an empty track and every figure reads zero — the
 * caller is expected to say in words that nothing has happened yet rather than
 * relying on the shape to imply it.
 * DOES NOT: draw a pie, and does not accept parts whose sum is not a real
 * quantity. Income and expenditure sum to nothing; that pair is BarRows on a
 * shared scale. See buildSplit's comment.
 *
 * Each segment's figure and share are printed in the legend beneath, because a
 * 6px slice of a track carries no number on its own.
 */
export function SplitBar({
  split,
  tones,
  format = String,
}: {
  split: Split;
  /** One colour token per segment, in the same order. */
  tones: readonly string[];
  format?: (value: number) => string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex h-2 w-full border border-[var(--border)]">
        {split.segments.map((segment, i) => (
          <div
            key={segment.label}
            style={{ width: `${segment.pct}%`, background: tones[i] ?? tones[0] }}
            aria-hidden
          />
        ))}
      </div>
      <div className="space-y-2">
        {split.segments.map((segment, i) => (
          <div key={segment.label} className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              {/* A 6px square rather than a coloured word: the console sets
                  labels in one muted tone and colouring them would be a second
                  meaning for the same ink. */}
              <span
                aria-hidden
                className="h-[6px] w-[6px] shrink-0"
                style={{ background: tones[i] ?? tones[0] }}
              />
              <span className={`${MICRO} truncate`}>{segment.label}</span>
            </span>
            <span className="font-mono text-sm font-medium text-[var(--text-primary)]">
              <Atomic>{format(segment.value)}</Atomic>
              <span className="ml-2 text-[var(--text-muted)]">
                {split.total > 0 ? `${Math.round(segment.pct)}%` : '—'}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

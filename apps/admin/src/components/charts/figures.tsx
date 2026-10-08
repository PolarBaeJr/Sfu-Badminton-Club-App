import { Atomic } from '@badminton/ui';
import { CLUB_TIMEZONE } from '@badminton/shared';

/**
 * THE ADMIN CONSOLE'S CHART PRIMITIVES — the figures, the labels and the empty
 * state. The shapes are in ./shapes.tsx and ./running-total.tsx; the maths is
 * in @/lib/charts.
 *
 * WHAT THIS MODULE IS FOR. The console is bare figures today: stat strips,
 * tables and counts, with no visualisation anywhere. These components are the
 * house's answer to that, and they are meant to be imported by /fees,
 * /sessions, /players, /seasons, /tournaments, /ratings and /audit — not only
 * by the dashboard. Everything here is area-agnostic; if you find yourself
 * wanting to add a prop named after a ledger or a season, the panel belongs in
 * the screen and only the shape belongs here.
 *
 * THE HOUSE RULES ARE BAKED IN so that nobody has to rediscover them:
 *
 *   - `--mono` for every number a human compares. Money, counts, ratings. The
 *     console's guidelines make this a rule and .stat-strip in globals.css
 *     already enforces it two classes deep for stat cells.
 *   - THE FIGURE IS ALWAYS PRINTED BESIDE THE SHAPE. A bar without its number
 *     is decoration: a reader cannot recover a value from a length, and on two
 *     rows they cannot reliably recover the ratio either. Not a tooltip, not a
 *     legend — on the row, at a size that reads on a phone.
 *   - No gradients, no shadows, radius 0. Hairline borders in `--border`.
 *   - NO NEW COLOUR VALUES. Every tone is passed in as an existing token
 *     (`var(--color-success)`, `var(--color-danger)`, `var(--color-warning)`,
 *     `var(--color-info)`, `var(--color-accent)`). Do not hard-code a hex.
 *   - Tracks and rules use `--border` / `--border-hover`, which are ALPHA
 *     NEUTRALS and read against #111 and #fff alike. Never `--surface-2` or
 *     `--surface-3`: the first resolves to #fff in the light theme, the same
 *     value as the card underneath it, and the second is a hard dark value that
 *     never flips. That is the white-on-white failure the loading skeletons in
 *     globals.css already document.
 *   - AN HONEST EMPTY STATE, NEVER AN EMPTY AXIS. Every shape below draws
 *     nothing when it has nothing, and the caller is expected to render
 *     ChartNote saying what would put something there.
 *
 * SERVER COMPONENTS. Every one renders from props with no state and no event
 * handler, so marking them 'use client' would ship the drawing code and its
 * data to the browser for a picture that never changes. They compose inside an
 * async server component.
 */

/** Money, formatted the way every finance card in this console formats it. */
export const money = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(2)}`;

/** A plain count, for the charts whose values are not money. */
export const count = (n: number) => String(n);

/** The console's micro-label: 10px mono caps, muted. Exported so panels match. */
export const MICRO =
  'font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]';

/**
 * `22 JUL` — short enough for the end of an axis at 10px.
 *
 * Takes a `YYYY-MM-DD` that is ALREADY a club-local calendar date (what
 * clubDayOf produces) and formats it in UTC. Re-reading it through
 * CLUB_TIMEZONE would shift it a second time and print the day before for
 * anything filed in the evening.
 */
export function chartDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' })
    .format(new Date(Date.UTC(y as number, (m as number) - 1, d as number, 12)))
    .toUpperCase();
}

/**
 * The club-local calendar day of an instant — what buildRunningTotal buckets by.
 *
 * A TIMESTAMPTZ recorded at 19:00 in Vancouver is the NEXT day in UTC, so
 * `iso.slice(0, 10)` files half the club's evening payments and check-ins under
 * tomorrow. Pass this to buildRunningTotal; that module stays timezone-agnostic
 * on purpose so it can be tested without one.
 */
export const clubDayOf = (iso: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: CLUB_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));

/**
 * A HEADLINE FIGURE AND WHAT IT MEANS.
 *
 * Mono, because it is a number a human compares against the ones under it.
 * `tone` is a colour token or nothing — a figure that is not good or bad news
 * takes the default ink rather than being coloured for decoration.
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
 * WHAT AN EMPTY SERIES SAYS.
 *
 * Not an axis with nothing on it, and not a card that quietly disappears. The
 * console's rule is that empty and withheld are different states and both are
 * said out loud. The register to match is the player app's — "play a rated
 * match to start your chart" — because it tells the reader what would put
 * something here rather than only that nothing is.
 */
export function ChartNote({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-[var(--text-muted)]">{children}</p>;
}

import { Card } from '@badminton/ui';
import {
  buildRunningAreaPath,
  buildRunningPath,
  buildRunningTotal,
  buildSplit,
  computeRunningScale,
  type Payment,
} from '@/lib/charts';
import {
  ChartFigure,
  ChartNote,
  MICRO,
  RUNNING_BOX,
  RunningTotalChart,
  SplitBar,
  clubDayOf,
  count,
} from '@/components/charts';

/**
 * THE TWO THINGS THIS ROSTER WILL NOT SAY ABOUT ITSELF.
 *
 *   "Is the club growing?"           the curve — a rate, all-time.
 *   "Who can actually play tonight?"  the split — a level, this tab.
 *
 * BOTH ARE BEHIND `players.read` AND COST NO QUERY. The curve folds the count
 * query the page already runs to populate its tab badges and its merge picker;
 * the split folds the tab's own rows and the waiver arithmetic the roster table
 * already does per row. Neither reads a fee, a session or a rating, so nothing
 * behind another area's key reaches either shape.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 *   THE LADDER. /admin/dashboard's LadderPanel already draws the club's rating
 *   spread, is gated on this same `players.read`, and LINKS HERE. Drawing the
 *   same two histograms again on the page it points at would be the same chart
 *   twice, which is the one thing worse on this screen than no chart at all.
 *
 *   A BREAKDOWN BY STATUS. Competitive, Recreational, Needs Attention,
 *   Suspended and Inactive are printed as five counts on the tabs above, so a
 *   shape dividing them up restates numbers already on the screen. The split
 *   below is NOT that chart: `standingOf()` folds four separate facts — banned,
 *   suspended, active_flag and the waiver — into the single answer an officer
 *   at the door needs, and that answer appears nowhere on this page except as a
 *   badge on each of five hundred rows.
 */

/** One member's standing, exactly as the roster row computes it. */
export interface StandingCount {
  label: string;
  value: number;
}

/**
 * The order the segments are read in: cleared to play first, then the states
 * that stop play, in the order standingOf() itself resolves them. Not sorted by
 * size — this is a fixed reading order, and a track whose segments reshuffle as
 * the club changes is one nobody can learn.
 */
const STANDING_ORDER = ['Active', 'No waiver', 'New', 'Inactive', 'Suspended', 'Banned'] as const;

/**
 * A tone per standing, all of them existing console tokens.
 *
 * Cleared to play is the success tone; a missing signature is the warning tone
 * the badge already uses; suspended and banned are the danger tone, which they
 * also already are. "New" and "Inactive" take the muted hairline rather than a
 * colour, because a pending signup is not bad news — it is work.
 */
const STANDING_TONES: Record<string, string> = {
  Active: 'var(--color-success)',
  'No waiver': 'var(--color-warning)',
  New: 'var(--border-hover)',
  Inactive: 'var(--border-hover)',
  Suspended: 'var(--color-danger)',
  Banned: 'var(--color-danger)',
};

export function RosterCharts({
  standings,
  tabLabel,
  tabTotal,
  joins,
  totalMembers,
  capped,
}: {
  /** How many members on the CURRENT TAB hold each standing. */
  standings: readonly StandingCount[];
  /** What the tab is called, so the split can name its own population. */
  tabLabel: string;
  /** The tab's full count. Larger than the standings sum only past the row cap. */
  tabTotal: number;
  /** One dated row per member, from the count query. See the note below. */
  joins: readonly Payment[];
  /** The club's size, as the page's eyebrow already prints it. */
  totalMembers: number;
  /**
   * True when the count query hit its row cap and the curve is short.
   *
   * The rows that go missing are NOT the earliest ones: that query orders by
   * `full_name`, so past the cap the members dropped are scattered across the
   * club's whole history. The note this flag renders therefore claims only that
   * some are absent, and never that the start of the line is.
   */
  capped: boolean;
}) {
  // SEGMENTS THAT NOBODY IS IN ARE DROPPED, not drawn at zero width. On the
  // Competitive tab nothing is ever suspended or pending — the tab's own filter
  // excludes both — so keeping them would print two permanent "0 · 0%" rows in
  // the legend of every roster the club will ever have.
  const present = STANDING_ORDER.map((label) => ({
    label,
    value: standings.find((s) => s.label === label)?.value ?? 0,
  })).filter((s) => s.value > 0);
  const split = buildSplit(present);
  const cleared = present.find((s) => s.label === 'Active')?.value ?? 0;

  // ONE POINT PER MEMBER, VALUED AT ONE. buildRunningTotal sums a field named
  // `cents` because money was its first caller; the module itself is explicit
  // that it knows nothing about money and takes "dated amounts". A join is
  // worth one member, so the running total is a headcount and the axis below is
  // labelled in members rather than dollars. Renaming the field would touch
  // five callers across /fees, /seasons and the dashboard for no behaviour.
  const points = buildRunningTotal(joins, clubDayOf);
  const scale = computeRunningScale(points, RUNNING_BOX);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card padding={false}>
        <Heading title="Standing" sub={`Where the ${tabLabel} roster stands right now.`} />
        <div className="space-y-4 px-4 py-4">
          {split.total === 0 ? (
            <ChartNote>
              There is nobody on this tab, so there is no standing to divide.
            </ChartNote>
          ) : (
            <>
              <ChartFigure
                label="Cleared to play"
                value={String(cleared)}
                tone={cleared > 0 ? 'var(--color-success)' : undefined}
                // NAMES ITS OWN POPULATION. This is the tab in front of the
                // reader and not the club, and the two differ by hundreds on a
                // real roster — a share printed without saying what it is a
                // share OF is the easiest number on this page to misread.
                sub={`Of ${split.total} on the ${tabLabel} tab. The club has ${totalMembers}.`}
              />
              {/* A split rather than bars: every member on the tab has exactly
                  one standing, so the segments genuinely sum to the tab. */}
              <SplitBar
                split={split}
                tones={split.segments.map((s) => STANDING_TONES[s.label] ?? 'var(--border-hover)')}
                format={count}
              />
              <p className="text-xs text-[var(--text-muted)]">
                One standing each, in the order that overrules: a banned member is banned
                whatever their waiver says. A missing signature is the only one the member
                can clear themselves.
              </p>
              {tabTotal > split.total && (
                // The roster read stops at 500 rows per tab. The tab's badge
                // above still counts the whole tab, so without this the two
                // numbers on one screen simply disagree.
                <p className="text-xs text-[var(--text-muted)]">
                  The {tabLabel} tab has {tabTotal} members; this covers the {split.total} the
                  roster read returned.
                </p>
              )}
            </>
          )}
        </div>
      </Card>

      <Card padding={false}>
        <Heading title="How the roster grew" sub="Every member the club has, by the day they joined." />
        <div className="space-y-4 px-4 py-4">
          {/* ALL-TIME, AND SAID SO. There is no season picker on this page and
              the count query is not scoped to one, so this curve spans the
              club's whole history. Calling it a term's joins would mislabel its
              own x domain — and the domain comes from the data regardless,
              never from a season row. */}
          {joins.length === 0 ? (
            <ChartNote>
              No member has a join date recorded, so there is nothing to plot.
            </ChartNote>
          ) : scale ? (
            <>
              <ChartFigure
                label="Members"
                value={String(totalMembers)}
                sub={`Joined across ${points.length} ${points.length === 1 ? 'day' : 'days'}.`}
              />
              <RunningTotalChart
                points={points}
                scale={scale}
                linePath={buildRunningPath(points, scale)}
                areaPath={buildRunningAreaPath(points, scale)}
                tone="var(--color-info)"
                noun={['member', 'members']}
                label={`How the roster grew: ${totalMembers} members joining across ${points.length} days, running total.`}
              />
              <p className="text-xs text-[var(--text-muted)]">
                Every member on the roster today, not only this tab, and all time rather than
                this term. A member who has left is not on the roster and so is not on the
                line — this is how the club got to its current size, not how many have ever
                been in it.
              </p>
              {capped && (
                <p className="text-xs text-[var(--text-muted)]">
                  The roster read stops at 5,000 members, so some members are missing from
                  the line.
                </p>
              )}
            </>
          ) : (
            // computeRunningScale refuses fewer than two dated days, and the
            // refusal matters most here: a club whose members were all imported
            // in one batch would otherwise draw a flat line reading "nobody
            // joined all year" over a roster of a hundred people.
            <ChartNote>
              Every member on the roster joined on the same day, so there is no line to draw
              yet. A curve needs two days — one more signup is enough.
            </ChartNote>
          )}
        </div>
      </Card>
    </div>
  );
}

/** The console's panel head. Same rule and same type as the other chart cards. */
function Heading({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="border-b border-[var(--border)] px-4 py-3">
      <h2 className="font-[family-name:var(--display)] text-[13px] font-bold uppercase tracking-[0.12em] text-[var(--ink)]">
        {title}
      </h2>
      <p className={`mt-1 ${MICRO} normal-case tracking-normal`}>{sub}</p>
    </div>
  );
}

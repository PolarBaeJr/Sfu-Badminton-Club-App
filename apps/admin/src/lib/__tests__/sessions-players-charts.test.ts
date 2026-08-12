import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnoutPanel } from '@/app/sessions/turnout-panel';
import { RosterCharts } from '@/app/players/roster-charts';
import { uniqueColumnLabels } from '@/lib/charts';

/**
 * THE CHART PANELS ON /sessions AND /players, RENDERED.
 *
 * Same split as fees-season-charts.test.ts: charts.test.ts pins the arithmetic,
 * and this pins WHICH BRANCH a panel takes for a given roster — which is the
 * half a pure-function test cannot reach, and the half a reader actually gets.
 * Every panel here has more than one honest-empty path, and they say different
 * things: "no night has been held yet" and "no door list has been taken" are
 * different facts about the club, and a panel that quietly collapsed them into
 * one sentence would pass every assertion about its maths.
 *
 * THE FIXTURES ARE STAGING'S ACTUAL SHAPE, read off the database on 2026-08-11
 * and transcribed rather than invented — five sessions dated 4–16 August inside
 * a season that runs September to December, an attendance table holding only
 * `checked_in` and `no_show`, and a hundred members created inside a
 * thirty-hour window. Every degenerate case below is one this club really
 * produces.
 *
 * createElement rather than JSX, and .ts rather than .tsx, for the reason the
 * sibling file gives: the admin vitest config compiles JSX but these are server
 * components with no state, so renderToStaticMarkup drives them exactly as a
 * request would.
 */

// GENERIC over the component's own props. This was typed as
// `Parameters<typeof h>[0]`, which createElement resolves to a component
// taking NO props — so every chart here, all of which take required props,
// was a type error while the tests themselves passed. Tying `props` to the
// component's parameter also means passing the wrong shape is now caught.
const html = <P,>(type: (props: P) => unknown, props: P) =>
  renderToStaticMarkup(h(type as never, props as never));

const up = (n: number) => Array.from({ length: n }, () => 'checked_in' as const);
const away = (n: number) => Array.from({ length: n }, () => 'no_show' as const);

// Staging's five sessions, with the roll exactly as it stands. The two on the
// 14th and 16th are in the future and have no rows at all.
const STAGING_NIGHTS = [
  { id: 'a', date: '2026-08-04', track: 'competitive', statuses: [...up(15), ...away(3)] },
  { id: 'b', date: '2026-08-06', track: 'recreational', statuses: [...up(16), ...away(2)] },
  { id: 'c', date: '2026-08-11', track: 'competitive', statuses: [...up(16), ...away(2)] },
  { id: 'd', date: '2026-08-14', track: 'competitive', statuses: [] },
  { id: 'e', date: '2026-08-16', track: 'recreational', statuses: [] },
];

describe('TurnoutPanel', () => {
  it('draws a column per night held, with the weekday and track on the tick', () => {
    const out = html(TurnoutPanel, {
      nights: STAGING_NIGHTS,
      today: '2026-08-11',
      seasonName: 'Fall 2026',
    });
    // Three nights held, 47 arrivals across a roll of 54.
    expect(out).toContain('Turned up');
    expect(out).toContain('>47<');
    expect(out).toContain('Across 3 nights of 54 marked on the door.');
    // The date is the label; the weekday and the track are the caption under
    // it, which is what makes "is Wednesday dying" answerable from one panel.
    expect(out).toContain('4 AUG');
    expect(out).toContain('TUE · COM');
    // THURSDAY, and the session staging seeded on this date is called "Wednesday
    // drop-in". The tick reads the date rather than the name for exactly this
    // reason: a club that moves a night and does not rename it would otherwise
    // have a turnout chart insisting Wednesday is fine.
    expect(out).toContain('THU · REC');
  });

  // THE TRAP THE SEASON BOUNDS SET. Fall 2026 runs 1 Sep to 31 Dec and every
  // seeded session is dated in August, so a domain taken from the season would
  // put all three nights off-canvas. The panel never reads a season date.
  it('charts nights dated outside the season it is scoped to', () => {
    const out = html(TurnoutPanel, {
      nights: STAGING_NIGHTS,
      today: '2026-08-11',
      seasonName: 'Fall 2026',
    });
    expect(out).toContain('6 AUG');
    expect(out).toContain('11 AUG');
  });

  // A NIGHT THAT HAS NOT HAPPENED IS NOT A ZERO. Drawing next Saturday at the
  // floor today reads as a collapse rather than as a calendar.
  it('leaves future nights off entirely rather than drawing them at the floor', () => {
    const out = html(TurnoutPanel, {
      nights: STAGING_NIGHTS,
      today: '2026-08-11',
      seasonName: 'Fall 2026',
    });
    expect(out).not.toContain('14 AUG');
    expect(out).not.toContain('16 AUG');
  });

  it('marks tonight as still running so its column is not read as final', () => {
    const out = html(TurnoutPanel, {
      nights: STAGING_NIGHTS,
      today: '2026-08-11',
      seasonName: 'Fall 2026',
    });
    expect(out).toContain('Tonight is still running');
  });

  it('says nothing about tonight when the last night charted is in the past', () => {
    const out = html(TurnoutPanel, {
      nights: STAGING_NIGHTS,
      today: '2026-08-13',
      seasonName: 'Fall 2026',
    });
    expect(out).not.toContain('Tonight is still running');
  });

  // THE DENOMINATOR A STACK ALWAYS IMPLIES. Fifteen at a club of a hundred is
  // not fifteen percent of anything, and this sentence is the only thing
  // standing between the reader and that reading.
  it('says the column is the roll as taken, not the club', () => {
    const out = html(TurnoutPanel, {
      nights: STAGING_NIGHTS,
      today: '2026-08-11',
      seasonName: 'Fall 2026',
    });
    expect(out).toContain('door list as it was taken that night');
    expect(out).toContain('never appeared are not counted');
  });

  // A ROLL TAKEN THAT CAME BACK EMPTY IS A REAL ZERO, and is drawn as one — an
  // empty tick with its figure under it. This is the case the stat strip's
  // average silently drops.
  it('draws a night everybody missed as a genuine zero', () => {
    const out = html(TurnoutPanel, {
      nights: [
        { id: 'a', date: '2026-08-04', track: 'competitive', statuses: [...up(15), ...away(3)] },
        { id: 'b', date: '2026-08-06', track: 'recreational', statuses: away(6) },
      ],
      today: '2026-08-11',
      seasonName: 'Fall 2026',
    });
    expect(out).toContain('6 AUG');
    expect(out).toContain('>0<');
    // Nothing was skipped: the roll exists, it just says nobody came.
    expect(out).not.toContain('no door list at all');
  });

  // AND THE OTHER EXCLUSION, which is a different fact and gets a different
  // sentence: no row at all means nobody wrote anything down.
  it('leaves a held night with no roll out, and says how many', () => {
    const out = html(TurnoutPanel, {
      nights: [
        { id: 'a', date: '2026-08-04', track: 'competitive', statuses: [...up(15), ...away(3)] },
        { id: 'b', date: '2026-08-06', track: 'recreational', statuses: [] },
      ],
      today: '2026-08-11',
      seasonName: 'Fall 2026',
    });
    expect(out).toContain('1 held night has no door list at all');
    expect(out).toContain('not the same as nobody coming');
    expect(out).not.toContain('6 AUG');
  });

  // CONDITIONAL, because on staging and on most terms it describes nothing. An
  // unconditional sentence about excluded nights is a sentence about something
  // that did not happen.
  it('says nothing about excluded nights when none were excluded', () => {
    const out = html(TurnoutPanel, {
      nights: STAGING_NIGHTS,
      today: '2026-08-11',
      seasonName: 'Fall 2026',
    });
    expect(out).not.toContain('no door list at all');
  });

  // TWO SESSIONS ON ONE DATE ARE LEGAL — the page's own comment says so — and
  // ColumnChart keys its columns by label, so without uniqueColumnLabels the
  // second night would vanish into the first with no error anywhere.
  it('draws two nights on one date as two columns', () => {
    const out = html(TurnoutPanel, {
      nights: [
        { id: 'a', date: '2026-08-04', track: 'competitive', statuses: up(15) },
        { id: 'b', date: '2026-08-04', track: 'recreational', statuses: up(4) },
      ],
      today: '2026-08-11',
      seasonName: 'Fall 2026',
    });
    expect(out).toContain('4 AUG');
    expect(out).toContain('4 AUG (2)');
    expect(out).toContain('Across 2 nights of 19 marked on the door.');
    expect(out).toContain('>15<');
    expect(out).toContain('>4<');
  });

  it('keeps the most recent nights when there are more than fit, and says so', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      id: `s${i}`,
      date: `2026-07-${String(i + 1).padStart(2, '0')}`,
      track: 'competitive',
      statuses: up(i + 1),
    }));
    const out = html(TurnoutPanel, { nights: many, today: '2026-08-11', seasonName: 'Fall 2026' });
    expect(out).toContain('3 earlier nights are in the table below');
    // The first three July nights are dropped; the last is kept. Anchored on
    // the tag boundaries because a bare '1 JUL' is a substring of '11 JUL' and
    // '21 JUL' and would pass over a chart that dropped nothing at all.
    expect(out).not.toContain('>1 JUL<');
    expect(out).not.toContain('>3 JUL<');
    expect(out).toContain('>4 JUL<');
    expect(out).toContain('>13 JUL<');
  });

  // THE TWO EMPTY STATES, which are different facts about the club and must not
  // collapse into one sentence.
  it('tells a schedule with nothing held yet apart from one with no rolls taken', () => {
    const nothingHeld = html(TurnoutPanel, {
      nights: [{ id: 'd', date: '2026-08-14', track: 'competitive', statuses: [] }],
      today: '2026-08-11',
      seasonName: 'Fall 2026',
    });
    expect(nothingHeld).toContain('No session in Fall 2026 has been held yet');

    const noRolls = html(TurnoutPanel, {
      nights: [{ id: 'a', date: '2026-08-04', track: 'competitive', statuses: [] }],
      today: '2026-08-11',
      seasonName: 'Fall 2026',
    });
    expect(noRolls).toContain('No door list has been taken');
  });

  it('names the schedule rather than a season when no season is in scope', () => {
    const out = html(TurnoutPanel, { nights: [], today: '2026-08-11', seasonName: null });
    expect(out).toContain('No session in this schedule has been held yet');
  });
});

// Staging's roster: a hundred members created across two club-local days, and
// only two of them holding any waiver acceptance at all.
const STAGING_JOINS = [
  ...Array.from({ length: 14 }, () => ({ at: '2026-08-06T21:25:23Z', cents: 1 })),
  ...Array.from({ length: 86 }, () => ({ at: '2026-08-07T21:42:16Z', cents: 1 })),
];

describe('RosterCharts', () => {
  it('divides the tab by standing and names the population it is dividing', () => {
    const out = html(RosterCharts, {
      standings: [
        { label: 'Active', value: 2 },
        { label: 'No waiver', value: 32 },
      ],
      tabLabel: 'Competitive',
      tabTotal: 34,
      joins: STAGING_JOINS,
      totalMembers: 100,
      capped: false,
    });
    expect(out).toContain('Cleared to play');
    // The share is of the TAB, and the club is named beside it so the two
    // cannot be confused for each other.
    expect(out).toContain('Of 34 on the Competitive tab. The club has 100.');
    expect(out).toContain('No waiver');
    expect(out).toContain('94%');
  });

  // A SEGMENT NOBODY IS IN IS DROPPED. The Competitive tab's own filter
  // excludes suspended and pending members, so a permanent "0 · 0%" row would
  // sit in the legend of every roster this club ever has.
  it('leaves out standings nobody holds rather than drawing empty segments', () => {
    const out = html(RosterCharts, {
      standings: [{ label: 'Active', value: 34 }],
      tabLabel: 'Competitive',
      tabTotal: 34,
      joins: STAGING_JOINS,
      totalMembers: 100,
      capped: false,
    });
    expect(out).not.toContain('Suspended');
    expect(out).not.toContain('Banned');
    expect(out).not.toContain('No waiver');
  });

  // FIXED READING ORDER, not sorted by size: a track whose segments reshuffle
  // as the club changes is one nobody can learn.
  it('orders the segments by what overrules what, not by size', () => {
    const out = html(RosterCharts, {
      standings: [
        { label: 'Suspended', value: 40 },
        { label: 'Active', value: 1 },
        { label: 'No waiver', value: 10 },
      ],
      // Not one of the segment names, so the tab's own label in the subtitle
      // above cannot be mistaken for a legend entry by the assertions below.
      tabLabel: 'Needs Attention',
      tabTotal: 51,
      joins: STAGING_JOINS,
      totalMembers: 100,
      capped: false,
    });
    expect(out.indexOf('Active')).toBeLessThan(out.indexOf('No waiver'));
    expect(out.indexOf('No waiver')).toBeLessThan(out.indexOf('Suspended'));
  });

  it('says so when the roster read stopped short of the tab it is describing', () => {
    const out = html(RosterCharts, {
      standings: [{ label: 'Active', value: 500 }],
      tabLabel: 'Competitive',
      tabTotal: 634,
      joins: STAGING_JOINS,
      totalMembers: 634,
      capped: false,
    });
    expect(out).toContain('The Competitive tab has 634 members; this covers the 500');
  });

  it('says nothing about the cap when the tab fits inside it', () => {
    const out = html(RosterCharts, {
      standings: [{ label: 'Active', value: 34 }],
      tabLabel: 'Competitive',
      tabTotal: 34,
      joins: STAGING_JOINS,
      totalMembers: 100,
      capped: false,
    });
    expect(out).not.toContain('this covers the');
  });

  it('has something to say for an empty tab', () => {
    const out = html(RosterCharts, {
      standings: [],
      tabLabel: 'Needs Attention',
      tabTotal: 0,
      joins: STAGING_JOINS,
      totalMembers: 100,
      capped: false,
    });
    expect(out).toContain('There is nobody on this tab');
  });

  // STAGING'S JOIN CURVE IS TWO DAYS AND IT DRAWS. Exactly the minimum
  // computeRunningScale accepts, so the seed produces one cliff rather than a
  // trend — honest, and visibly a seed.
  it('draws the growth curve from the data, all time, and labels it in members', () => {
    const out = html(RosterCharts, {
      standings: [{ label: 'Active', value: 34 }],
      tabLabel: 'Competitive',
      tabTotal: 34,
      joins: STAGING_JOINS,
      totalMembers: 100,
      capped: false,
    });
    expect(out).toContain('How the roster grew');
    expect(out).toContain('Joined across 2 days.');
    expect(out).toContain('100 members');
    expect(out).toContain('6 AUG');
    expect(out).toContain('7 AUG');
    // Not a term, and it says so — this page has no season scope at all.
    expect(out).toContain('all time rather than this term');
  });

  // THE REFUSAL THAT MATTERS MOST HERE. A club whose members were all imported
  // in one batch would draw a flat line reading "nobody joined all year" over a
  // roster of a hundred people.
  it('refuses a line when every member joined on one day, and says what would draw one', () => {
    const out = html(RosterCharts, {
      standings: [{ label: 'Active', value: 34 }],
      tabLabel: 'Competitive',
      tabTotal: 34,
      joins: Array.from({ length: 100 }, () => ({ at: '2026-08-07T21:42:16Z', cents: 1 })),
      totalMembers: 100,
      capped: false,
    });
    expect(out).toContain('joined on the same day');
    expect(out).toContain('one more signup is enough');
  });

  it('says so when the roster read hit its own row cap', () => {
    const out = html(RosterCharts, {
      standings: [{ label: 'Active', value: 500 }],
      tabLabel: 'Competitive',
      tabTotal: 500,
      joins: STAGING_JOINS,
      totalMembers: 5000,
      capped: true,
    });
    expect(out).toContain('stops at 5,000 members');
  });

  it('has something to say for a club with no join dates at all', () => {
    const out = html(RosterCharts, {
      standings: [{ label: 'Active', value: 1 }],
      tabLabel: 'Competitive',
      tabTotal: 1,
      joins: [],
      totalMembers: 1,
      capped: false,
    });
    expect(out).toContain('No member has a join date recorded');
  });
});

describe('uniqueColumnLabels', () => {
  it('returns already-distinct labels exactly as given', () => {
    expect(uniqueColumnLabels(['4 AUG', '6 AUG', '11 AUG'])).toEqual(['4 AUG', '6 AUG', '11 AUG']);
  });

  // Only the SECOND and later occurrences are suffixed, so the ordinary case
  // still reads as the club's own names.
  it('suffixes only the repeats, in arrival order', () => {
    expect(uniqueColumnLabels(['Fall 2026', 'Fall 2026', 'Fall 2026'])).toEqual([
      'Fall 2026',
      'Fall 2026 (2)',
      'Fall 2026 (3)',
    ]);
  });

  it('preserves order and drops nothing', () => {
    const input = ['b', 'a', 'b', 'c', 'a'];
    const out = uniqueColumnLabels(input);
    expect(out).toHaveLength(input.length);
    expect(out).toEqual(['b', 'a', 'b (2)', 'c', 'a (2)']);
    // Distinct, which is the whole point — ColumnChart keys on these.
    expect(new Set(out).size).toBe(out.length);
  });

  it('has nothing to say about an empty set', () => {
    expect(uniqueColumnLabels([])).toEqual([]);
  });
});

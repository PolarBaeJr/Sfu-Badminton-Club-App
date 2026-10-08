import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnoutPanel } from '@/app/sessions/turnout-panel';
import { uniqueColumnLabels } from '@/lib/charts';

/**
 * THE CHART PANEL ON /sessions, RENDERED.
 *
 * Same split as fees-season-charts.test.ts: charts.test.ts pins the arithmetic,
 * and this pins WHICH BRANCH the panel takes for a given schedule, which is the
 * half a pure-function test cannot reach, and the half a reader actually gets.
 * The panel has more than one honest-empty path, and they say different
 * things: "no night has been held yet" and "no door list has been taken" are
 * different facts about the club, and a panel that quietly collapsed them into
 * one sentence would pass every assertion about its maths.
 *
 * THE FIXTURES ARE STAGING'S ACTUAL SHAPE, read off the database on 2026-08-11
 * and transcribed rather than invented: five sessions dated 4 to 16 August
 * inside a season that runs September to December, and an attendance table
 * holding only `checked_in` and `no_show`. Every degenerate case below is one
 * this club really produces.
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

  // The panel used to carry two standing paragraphs under the chart — one
  // spelling out that a column is the roll rather than the club, one saying
  // tonight's column was not final. Both were removed as noise: they were on
  // screen every time the panel drew, whether or not they described anything.
  // The two remaining notes below are conditional, which is the difference —
  // they appear only on the terms they actually describe.
  it('does not carry the removed standing paragraphs', () => {
    const out = html(TurnoutPanel, {
      nights: STAGING_NIGHTS,
      today: '2026-08-11',
      seasonName: 'Fall 2026',
    });
    expect(out).not.toContain('door list as it was taken that night');
    expect(out).not.toContain('still running, so its column is not final');
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

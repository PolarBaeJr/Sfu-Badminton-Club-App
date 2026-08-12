import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EntriesByEvent } from '@/app/tournaments/entries-by-event';
import type { IndexEvent } from '@/lib/tournament-index';
import { KFactorPanel } from '@/app/ratings/k-factor-panel';
import { AuditActivityChart } from '@/app/audit/activity-chart';

/**
 * THE CHART PANELS ON /tournaments, /ratings AND /audit, RENDERED.
 *
 * Same split as fees-season-charts.test.ts: charts.test.ts pins the arithmetic,
 * and this pins WHICH BRANCH a panel takes for a given set of rows — the half a
 * pure-function test cannot reach, and the half a reader actually gets. Each of
 * these three has a refusal in it that a maths test would sail straight past: a
 * capacity that must not be drawn when any event is uncapped, a K-factor that
 * must come from settings rather than the engine's constants, and a scale that
 * returns null on one day and must produce a SENTENCE rather than nothing.
 *
 * THE FIXTURES ARE STAGING'S ACTUAL SHAPE, read off the database on 2026-08-11
 * and transcribed rather than invented: an open tournament whose two events are
 * both capped and one of which is completely empty, a six-event tournament with
 * three separate `mens_singles` draws and no caps at all, a rating_defaults row
 * whose K-factors have been EDITED away from the engine defaults, and an audit
 * log of twenty rows spread over six days.
 *
 * createElement rather than JSX, and .ts rather than .tsx, for the reason the
 * sibling files give: these are server components with no state and no effects,
 * so renderToStaticMarkup drives them exactly as a request would.
 */

// GENERIC over the component's own props. This was typed as
// `Parameters<typeof h>[0]`, which createElement resolves to a component
// taking NO props — so every chart here, all of which take required props,
// was a type error while the tests themselves passed. Tying `props` to the
// component's parameter also means passing the wrong shape is now caught.
const html = <P,>(type: (props: P) => unknown, props: P) =>
  renderToStaticMarkup(h(type as never, props as never));

// Typed against IndexEvent rather than with a bare `string`, so a fixture
// cannot invent an event type the component would never be handed.
const ev = (
  id: string,
  event_type: IndexEvent['event_type'],
  max_participants: number | null,
  status = 'registration',
): IndexEvent => ({
  id, tournament_id: 't1', event_type, status, draw_locked: false, max_participants,
});

const rows = (eventId: string, n: number) =>
  Array.from({ length: n }, () => ({ event_id: eventId }));

/* -------------------------------------------------------------------------- */
/* /tournaments                                                                */
/* -------------------------------------------------------------------------- */

// Staging's open tournament: Open Singles capped at 16 with nine entrants, and
// Open Doubles capped at 8 with nobody at all. The headline above the panel
// reads "9 of 24", which is exactly what conceals the empty event.
const OPEN_TOURNAMENT = [ev('e-singles', 'open_singles', 16), ev('e-doubles', 'open_doubles', 8)];

describe('EntriesByEvent', () => {
  it('splits the headline into its events and shows the empty one', () => {
    const out = html(EntriesByEvent, {
      events: OPEN_TOURNAMENT,
      participants: rows('e-singles', 9),
      pairs: [],
    });
    expect(out).toContain('Open Singles');
    expect(out).toContain('Open Doubles');
    // Nine in one, nobody in the other — the fact the total cannot express.
    expect(out).toContain('>9<');
    expect(out).toContain('>0<');
  });

  it('draws capacity only when every event carries a cap', () => {
    const out = html(EntriesByEvent, {
      events: OPEN_TOURNAMENT,
      participants: rows('e-singles', 9),
      pairs: [],
    });
    expect(out).toContain('OF 16');
    expect(out).toContain('OF 8');
    expect(out).toContain('the column is the event');
  });

  it('draws NO capacity when a single event is uncapped, and says why', () => {
    // capacityOf's rule, at event granularity. One uncapped event and the
    // denominator is gone for the whole chart — never a mixed axis.
    const out = html(EntriesByEvent, {
      events: [ev('e-singles', 'open_singles', 16), ev('e-doubles', 'open_doubles', null)],
      participants: rows('e-singles', 9),
      pairs: [],
    });
    expect(out).not.toContain('OF 16');
    expect(out).toContain('no entry limit set');
  });

  it('counts a doubles event in draw slots, not people, and says so', () => {
    // Three loose entrants and one formed pair is 1 + ceil(3/2) = 3 slots, NOT
    // the five rows the index's tournament-level count would see.
    const out = html(EntriesByEvent, {
      events: [ev('e-doubles', 'open_doubles', null)],
      participants: rows('e-doubles', 3),
      pairs: rows('e-doubles', 1),
    });
    expect(out).toContain('>3<');
    expect(out).toContain('waiting for a partner');
  });

  it('stays silent about draw slots when everyone is paired', () => {
    // The ordinary case: no discrepancy with the headline, so no note.
    const out = html(EntriesByEvent, {
      events: [ev('e-doubles', 'open_doubles', null)],
      participants: [],
      pairs: rows('e-doubles', 4),
    });
    expect(out).toContain('>4<');
    expect(out).not.toContain('waiting for a partner');
  });

  it('keeps three draws of the same event type as three columns', () => {
    // Staging's six-event tournament really does run three `mens_singles`
    // draws. ColumnChart keys by label, so without the suffix two of the three
    // would collapse into one React child and simply vanish.
    const out = html(EntriesByEvent, {
      events: [
        ev('a', 'mens_singles', null),
        ev('b', 'mens_singles', null),
        ev('c', 'mens_singles', null),
      ],
      participants: [...rows('a', 12), ...rows('b', 98), ...rows('c', 3)],
      pairs: [],
    });
    expect(out).toContain('(2)');
    expect(out).toContain('(3)');
    expect(out).toContain('>12<');
    expect(out).toContain('>98<');
    expect(out).toContain('>3<');
  });

  it('never draws a negative remainder for an over-full event', () => {
    // A cap lowered after entries were taken. wouldExceedCapacity permits that
    // state, so the panel has to render it rather than producing a negative
    // height that would invert the stack.
    const out = html(EntriesByEvent, {
      events: [ev('e-singles', 'open_singles', 4)],
      participants: rows('e-singles', 9),
      pairs: [],
    });
    expect(out).toContain('>9<');
    // The remainder clamps to an empty segment rather than a negative height,
    // which would otherwise invert the stack and draw the overflow downward.
    expect(out).toContain('height:0%');
    expect(out).not.toMatch(/height:-/);
    // The cap is still printed, because being over it is the thing to notice.
    expect(out).toContain('OF 4');
  });

  it('says what would put something here when there are no events', () => {
    const out = html(EntriesByEvent, { events: [], participants: [], pairs: [] });
    expect(out).toContain('no events yet');
  });
});

/* -------------------------------------------------------------------------- */
/* /ratings                                                                    */
/* -------------------------------------------------------------------------- */

// Staging's rating_defaults, which has been EDITED: the engine's own defaults
// are 80/48 for singles and 64/36 for doubles, and this club runs 64/36 for
// both. A panel printing the constants would be wrong here and nowhere else.
const STAGING_K = {
  singlesProvisional: 64,
  singlesEstablished: 36,
  doublesProvisional: 64,
  doublesEstablished: 36,
};

describe('KFactorPanel', () => {
  it('prints the K-factors the club has configured, not the engine defaults', () => {
    const out = html(KFactorPanel, {
      total: 98,
      singlesProvisional: 6,
      doublesProvisional: 12,
      k: STAGING_K,
    });
    expect(out).toContain('K64');
    expect(out).toContain('K36');
    // The engine's untouched singles values, which this club does not use.
    expect(out).not.toContain('K80');
    expect(out).not.toContain('K48');
  });

  it('derives the established count as the complement of the provisional one', () => {
    const out = html(KFactorPanel, {
      total: 98,
      singlesProvisional: 6,
      doublesProvisional: 12,
      k: STAGING_K,
    });
    // 98 - 6 settled singles, 98 - 12 settled doubles. Every rated member is on
    // one K-factor or the other, so these are not a fifth and sixth figure that
    // could disagree with the counts printed above the panel.
    expect(out).toContain('>92<');
    expect(out).toContain('>86<');
    expect(out).toContain('>6<');
    expect(out).toContain('>12<');
  });

  it('says the settings reach nobody rather than drawing four empty bars', () => {
    const out = html(KFactorPanel, {
      total: 0,
      singlesProvisional: 0,
      doublesProvisional: 0,
      k: STAGING_K,
    });
    expect(out).toContain('reach nobody');
    expect(out).not.toContain('K64');
  });

  it('formats the counts as counts, never as money', () => {
    const out = html(KFactorPanel, {
      total: 98,
      singlesProvisional: 6,
      doublesProvisional: 12,
      k: STAGING_K,
    });
    // `cents` is the BarPart field name and holds a head count here. The money
    // formatter would render "$0.98", which is the failure this pins.
    expect(out).not.toContain('$');
  });
});

/* -------------------------------------------------------------------------- */
/* /audit                                                                      */
/* -------------------------------------------------------------------------- */

// Staging's audit log: twenty rows over six club-local days.
const STAGING_LOG = [
  ...Array.from({ length: 1 }, () => ({ created_at: '2026-08-06T18:00:00Z' })),
  ...Array.from({ length: 5 }, () => ({ created_at: '2026-08-07T18:00:00Z' })),
  ...Array.from({ length: 2 }, () => ({ created_at: '2026-08-09T18:00:00Z' })),
  ...Array.from({ length: 4 }, () => ({ created_at: '2026-08-10T18:00:00Z' })),
  ...Array.from({ length: 7 }, () => ({ created_at: '2026-08-11T18:00:00Z' })),
  ...Array.from({ length: 1 }, () => ({ created_at: '2026-08-12T18:00:00Z' })),
];

describe('AuditActivityChart', () => {
  it('draws the run and counts the actions in its own noun', () => {
    const out = html(AuditActivityChart, { logs: STAGING_LOG, scopeLabel: 'Fall 2026' });
    expect(out).toContain('20 actions');
    expect(out).toContain('Fall 2026');
    // A step path, never a diagonal: nothing happened on 8 August and the shape
    // has to say so. Horizontal-then-vertical is what an H/V pair encodes.
    expect(out).toContain('<path');
    expect(out).toMatch(/ H[\d.]+ V[\d.]+/);
  });

  it('buckets by club-local day, not by slicing the UTC string', () => {
    // 03:00Z on the 12th is 20:00 on the 11th in Vancouver. Slicing the ISO
    // string would file it under a seventh day; the club sees six.
    const out = html(AuditActivityChart, {
      logs: [
        { created_at: '2026-08-11T18:00:00Z' },
        { created_at: '2026-08-12T03:00:00Z' },
      ],
      scopeLabel: 'Last 30 days',
    });
    // Both land on 11 August, which leaves ONE dated day — and one day is not a
    // series, so the panel refuses rather than stretching a dot across the box.
    expect(out).toContain('happened on one day');
  });

  it('refuses a single day with a sentence rather than a flat line', () => {
    const out = html(AuditActivityChart, {
      logs: [{ created_at: '2026-08-11T18:00:00Z' }, { created_at: '2026-08-11T19:00:00Z' }],
      scopeLabel: 'Last 30 days',
    });
    expect(out).toContain('happened on one day');
    expect(out).not.toContain('<path');
  });

  it('says nothing was recorded rather than drawing an empty axis', () => {
    const out = html(AuditActivityChart, { logs: [], scopeLabel: 'Full history' });
    expect(out).toContain('Nothing was recorded');
    expect(out).not.toContain('<path');
  });

  it('reads only created_at, so no name can reach the drawing', () => {
    const out = html(AuditActivityChart, {
      logs: STAGING_LOG.map((l) => ({ ...l, actor: { full_name: 'Aiko Tanaka' }, reason: 'x' })),
      scopeLabel: 'Fall 2026',
    });
    expect(out).not.toContain('Aiko');
  });
});

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeftRight, ChevronLeft, ChevronRight } from 'lucide-react';
import type { CalendarMonth } from '@/lib/schedule';
import type { CalendarItem, CalendarTone } from '@/lib/calendar-items';

// Every string on an item was formatted on the server: this component does no
// date maths and holds no clock, so it cannot disagree with the agenda beside
// it. Sessions, club events and tournaments share the grid, told apart by the
// badge vocabulary the rest of the app already speaks.
const TONE_CLASS: Record<CalendarTone, string> = {
  open: 'tag tag-win',
  closed: 'tag',
  club: 'tag tag-gold cal-ev-club',
  tournament: 'tag tag-outline',
  cancelled: 'tag cal-ev-cancelled',
};

const TONE_WORD: Record<CalendarTone, string> = {
  open: 'open',
  closed: 'closed',
  club: 'Club event',
  tournament: 'Tournament',
  cancelled: 'Cancelled',
};

const LEGEND_LABEL: Record<CalendarTone, string> = {
  open: 'Session',
  closed: 'Closed',
  club: 'Club event',
  tournament: 'Tournament',
  cancelled: 'Cancelled',
};

interface MonthCalendarProps {
  /**
   * The months the arrows can reach, oldest first — the active term end to
   * end, plus a month of its own for any night that sits outside it (see
   * calendarMonthKeys). The nav is bounded to this list on purpose: the page
   * fetches the ACTIVE SEASON's sessions and any night with no term on it, so
   * a month outside it would render empty whether or not the club played that
   * month. Refusing to go there is the honest answer; a blank grid would be a
   * claim we cannot support.
   *
   * The list can therefore have holes in it — an old season-less night is one
   * reachable month with years of nothing on either side, and stepping off it
   * lands back at the term. The note under the grid is what says so.
   */
  months: CalendarMonth<CalendarItem>[];
  initialIndex: number;
  weekdays: string[];
  /** The kinds the page actually loaded, named in a key under the grid. */
  legend?: CalendarTone[];
}

export function MonthCalendar({ months, initialIndex, weekdays, legend }: MonthCalendarProps) {
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(initialIndex, 0), Math.max(months.length - 1, 0))
  );

  const month = months[index];
  if (!month) return null;

  const atStart = index === 0;
  const atEnd = index === months.length - 1;

  return (
    <div>
      <div className="cal-head">
        {/* aria-live, because the arrows change this text and nothing else:
            without it a screen-reader user taps "Next month" and is told
            nothing at all. */}
        <h2 className="cal-title" aria-live="polite">{month.label}</h2>
        <div className="cal-nav">
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(i - 1, 0))}
            disabled={atStart}
            aria-label="Previous month"
            title={atStart ? 'Nothing loaded before this month' : 'Previous month'}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            onClick={() => setIndex((i) => Math.min(i + 1, months.length - 1))}
            disabled={atEnd}
            aria-label="Next month"
            title={atEnd ? 'Nothing loaded after this month' : 'Next month'}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Says the grid moves, because nothing else does. At 390px the box shows
          Sun to about halfway through Wednesday, and a month grid's own edge
          reads as a margin rather than as a cut — unlike the chip rails
          elsewhere on the app, where a half-visible chip advertises its own
          overflow. CSS shows it only under 662px — the measured width at which
          the 620px grid floor stops being wider than its box — so it never
          promises a drag on a screen where the whole week already fits. */}
      <p className="cal-hint">
        <ArrowLeftRight size={12} aria-hidden="true" />
        Scroll sideways for the full week
      </p>

      {/* Horizontal scroll rather than seven crushed columns. A phone cannot
          give a month grid enough width to print a session's NAME in a cell,
          and a grid of anonymous coloured dots is a worse answer than one the
          member drags sideways — the cards above it are the primary surface on
          that screen anyway. The scroll is inside this box, so the page body
          never scrolls sideways. */}
      <div className="cal-scroll">
        <div className="cal-dow" aria-hidden="true">
          {weekdays.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <div className="cal-grid">
          {month.weeks.map((week) =>
            week.map((cell) => (
              <div
                key={cell.dateISO}
                className={[
                  'cal-cell',
                  cell.inMonth ? '' : 'is-out',
                  cell.isToday ? 'is-today' : '',
                  cell.sessions.length > 0 ? 'has-sessions' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <time className="cal-daynum" dateTime={cell.dateISO}>
                  {cell.day}
                  {cell.isToday && <span className="sr-only"> (today)</span>}
                </time>
                {cell.sessions.map((ev) => {
                  // `title` is still here for a mouse, but it is no longer the
                  // only copy of the name: .cal-ev-name WRAPS now. A phone
                  // and a tablet have no hover, so a name clipped to
                  // "WEDNESD…" with the rest behind a tooltip was unreadable
                  // on exactly the devices that clip it hardest.
                  // The badge vocabulary the rest of the page already speaks:
                  // .tag-win is the same green the "N OPEN" pill uses, plain
                  // .tag is the same grey a closed night wears in Past
                  // sessions. .cal-ev only re-shapes them into a full-width
                  // 44px block; it invents no colour.
                  //
                  // The <span> branch carries the SAME .cal-ev, so a night
                  // with no card to jump to is the same size as one that has
                  // it. That is 44px spent on something you cannot press, and
                  // it is the right trade: two chips of different heights
                  // stacked in one cell reads as a layout fault, and the
                  // member has no way to know which of them is a link until
                  // they try. Uniform, or the grid stops looking like a grid.
                  const cls = `${TONE_CLASS[ev.tone]} cal-ev${ev.mine ? ' is-mine' : ''}`;
                  const label = [ev.name, ev.timeLabel, TONE_WORD[ev.tone]]
                    .filter(Boolean)
                    .join(' · ');
                  const body = <span className="cal-ev-name">{ev.name}</span>;
                  if (!ev.href) {
                    return (
                      <span key={ev.key} className={cls} title={label}>
                        {body}
                      </span>
                    );
                  }
                  // A card on this page is an in-page jump; anything else is a
                  // route of its own.
                  return ev.href.startsWith('#') ? (
                    <a key={ev.key} href={ev.href} className={cls} title={label}>
                      {body}
                    </a>
                  ) : (
                    <Link key={ev.key} href={ev.href} className={cls} title={label}>
                      {body}
                    </Link>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>

      {legend && legend.length > 0 && (
        <p className="cal-legend">
          {legend.map((tone) => (
            <span key={tone} className="cal-legend-item">
              <span className={`cal-swatch is-${tone}`} aria-hidden="true" />
              {LEGEND_LABEL[tone]}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

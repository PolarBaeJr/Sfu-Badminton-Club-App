'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { CalendarMonth } from '@/lib/schedule';

/**
 * One session as the calendar needs it. Every string on it was formatted on
 * the server — this component does no date maths and holds no clock, so it
 * cannot disagree with the schedule in the rail beside it.
 */
export interface CalendarEvent {
  id: string;
  date: string;
  name: string;
  /** 'open' or 'closed' — the session_status enum has no third value. */
  status: string;
  /** "6:30 PM", or null for a night with no start time on it yet. */
  timeLabel: string | null;
  /** This member has said yes to it, or is already on the attendance list. */
  mine: boolean;
  /** True when there is a card in the rail for this id to jump to. */
  linkable: boolean;
}

interface MonthCalendarProps {
  /**
   * Every month the loaded data covers, oldest first. The nav is bounded to
   * this list on purpose: the page fetches the ACTIVE SEASON's sessions and
   * nothing else, so a month outside it would render empty whether or not the
   * club played that month. Refusing to go there is the honest answer; a blank
   * grid would be a claim we cannot support.
   */
  months: CalendarMonth<CalendarEvent>[];
  initialIndex: number;
  weekdays: string[];
  /** Named in the "that's all we loaded" note under the grid. */
  rangeLabel: string | null;
}

export function MonthCalendar({ months, initialIndex, weekdays, rangeLabel }: MonthCalendarProps) {
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
                  // The badge vocabulary the rest of the page already speaks:
                  // .tag-win is the same green the "N OPEN" pill uses, plain
                  // .tag is the same grey a closed night wears in Past
                  // sessions. .cal-ev only re-shapes them into a full-width
                  // one-line block; it invents no colour.
                  const cls = `tag ${ev.status === 'open' ? 'tag-win' : ''} cal-ev${ev.mine ? ' is-mine' : ''}`;
                  const label = [
                    ev.name,
                    ev.timeLabel,
                    ev.status === 'open' ? 'open' : 'closed',
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return ev.linkable ? (
                    <a key={ev.id} href={`#session-${ev.id}`} className={cls} title={label}>
                      <span className="cal-ev-name">{ev.name}</span>
                    </a>
                  ) : (
                    <span key={ev.id} className={cls} title={label}>
                      <span className="cal-ev-name">{ev.name}</span>
                    </span>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>

      {rangeLabel && (
        <p className="cal-foot">
          {/* Says out loud where the arrows stop and why, so a dead arrow reads
              as a boundary rather than a broken button. */}
          Showing {rangeLabel}. Nights from other terms are not on this calendar.
        </p>
      )}
    </div>
  );
}

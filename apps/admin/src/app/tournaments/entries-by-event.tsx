import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  doublesDrawSlots,
  isDoublesEvent,
  type TournamentEventType,
} from '@badminton/shared';
import { buildColumns } from '@/lib/charts';
import { ChartNote, ColumnChart, count } from '@/components/charts';
import type { IndexEvent } from '@/lib/tournament-index';

/**
 * WHERE THE OPEN TOURNAMENT'S ENTRIES ACTUALLY ARE — one column per event.
 *
 * THE QUESTION: the card above this one prints "9 of 24", which is the right
 * headline and hides the only thing an officer can act on. On staging that 9 is
 * nine entries in the singles and NOBODY in the doubles — an event that will
 * not run unless somebody goes and finds eight people this week. A total cannot
 * say that, and the index's table cannot either: it rolls entries up to the
 * TOURNAMENT row, so the per-event split exists nowhere on this screen. That is
 * the whole reason this panel is here, and it is why it sits directly under the
 * headline it decomposes rather than in the table's column.
 *
 * COLUMNS, NOT BARS, because the events of a tournament have an order the club
 * set and reads them in. See buildColumns for that rule.
 *
 * ---- THE DENOMINATOR, AND WHEN THERE ISN'T ONE -------------------------------
 *
 * `max_participants` is nullable and mostly null — six of staging's eight
 * events carry no cap. capacityOf() in @/lib/tournament-index already settled
 * what to do about that for the tournament row: one uncapped event and there is
 * NO denominator, so a bare count is shown and no bar. This panel obeys the
 * same rule at the same granularity rather than inventing a second answer —
 * every event capped, or no capacity drawn at all.
 *
 * Mixing the two in one chart is the specific failure this avoids. buildColumns
 * measures every column against the TALLEST TOTAL, so a capped event drawn to
 * its capacity beside an uncapped event drawn to its entry count puts two
 * different quantities on one axis: a 98-entry uncapped event would tower over
 * a 16-slot capped one and read as the fuller of the two when it is the only
 * one whose fullness is unknown.
 *
 * ---- COUNTING ENTRIES, NOT PEOPLE -------------------------------------------
 *
 * A singles entry is a `tournament_participants` row. A doubles entry is a
 * TEAM, and a doubles event also holds loose entrants who have not been paired
 * yet — those are participant rows too. `max_participants` counts DRAW SLOTS,
 * which is formed pairs plus one slot per two loose entrants, and that is not a
 * house preference: it is exactly what addParticipantToEvent enforces with
 * (lib/tournament-actions/participants.ts uses doublesDrawSlots for the same
 * check). Counting participant rows instead would let forty unpaired people
 * read as forty entries in an event with room for eight teams.
 *
 * SO THIS CAN DISAGREE WITH THE HEADLINE ABOVE IT, in exactly one situation,
 * and the panel says so when it arises. The index's own `entriesByTournament`
 * counts ROWS — one pair is one entry, one participant is one entry — which
 * matches draw slots for every singles event and for every doubles event whose
 * entrants are all paired. It differs only when a doubles event has loose
 * entrants: three of them are three rows and two draw slots. Rather than
 * silently print columns that do not sum to the figure above, the note below
 * appears and names the discrepancy. Staging has no loose entrants anywhere, so
 * the two agree there and the note stays hidden.
 *
 * ---- COST ---------------------------------------------------------------
 *
 * NO QUERY. The events, the participants and the pairs are all already fetched
 * by the page under `tournaments.page` for the table and the seed list, and
 * every figure here is a fold of those rows. Nothing on this panel is money, so
 * `tournaments.fees.read` is not involved and cannot leak through it.
 */

/** One participant row, in the only shape this panel needs. */
export interface EntryParticipant {
  event_id: string;
}

/** One pair row, likewise. */
export interface EntryPair {
  event_id: string;
}

/**
 * Labels ColumnChart can key on.
 *
 * A tournament may run the SAME event type more than once — staging's six-event
 * tournament has three `mens_singles` rows, which are three separate draws — and
 * ColumnChart keys its columns by label, so without this they would collapse
 * into one React child and two of the three would vanish. The suffix is only
 * ever added from the second occurrence onward, so the ordinary tournament
 * still reads as the club named its events. Same fix, same reason, as
 * uniqueLabels() in ../seasons/trend-panel.tsx.
 */
function uniqueLabels(events: readonly IndexEvent[]): string[] {
  const seen = new Map<string, number>();
  return events.map((e) => {
    const base =
      TOURNAMENT_EVENT_TYPE_LABELS[e.event_type as TournamentEventType] ?? e.event_type;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

export function EntriesByEvent({
  events,
  participants,
  pairs,
}: {
  /** The open tournament's events, in the order the page holds them. */
  events: readonly IndexEvent[];
  /** Every non-withdrawn participant row the page fetched, for any event. */
  participants: readonly EntryParticipant[];
  pairs: readonly EntryPair[];
}) {
  if (events.length === 0) {
    return (
      <ChartNote>
        This tournament has no events yet, so there is nothing to enter. Add one to start
        taking entries.
      </ChartNote>
    );
  }

  const labels = uniqueLabels(events);

  const perEvent = events.map((event) => {
    const loose = participants.filter((p) => p.event_id === event.id).length;
    const formed = pairs.filter((p) => p.event_id === event.id).length;
    const doubles = isDoublesEvent(event.event_type);
    return {
      event,
      // Draw slots for doubles, rows for singles — the unit the cap is enforced in.
      entries: doubles ? doublesDrawSlots(formed, loose) : loose,
      // Only a doubles event can hold a loose entrant; a participant row in a
      // singles event IS the entry.
      loose: doubles ? loose : 0,
    };
  });

  // Every event capped, or no capacity at all. See the header.
  const capped = events.every((e) => e.max_participants != null && e.max_participants > 0);
  const anyLoose = perEvent.some((row) => row.loose > 0);

  const columns = buildColumns(
    perEvent.map(({ event, entries }, i) => ({
      label: labels[i]!,
      value: entries,
      // The empty seats, stacked above the filled ones. Entries plus room left
      // IS the event's capacity, so this is a real total rather than two
      // categories piled up — the one composition buildColumns' `under` is for.
      // Clamped at zero because an event can legitimately sit OVER its own cap:
      // the limit may have been lowered after entries were taken, and
      // wouldExceedCapacity permits slot-neutral edits in that state.
      under: capped ? Math.max(0, (event.max_participants ?? 0) - entries) : undefined,
      note: capped ? `OF ${event.max_participants}` : undefined,
    })),
  );

  return (
    <div className="space-y-3">
      <ColumnChart
        columns={columns}
        tone="var(--color-accent)"
        // An alpha neutral for the empty seats, never a surface token — those
        // resolve to the card's own colour in one theme or the other. See the
        // house rules in @/components/charts.
        underTone="var(--border)"
        format={count}
        height={80}
      />
      {capped ? (
        // Which part of the column is which. Without this the taller stack
        // reads as the busier event rather than the larger one.
        <p className="text-xs text-[var(--text-muted)]">
          The solid part is entries taken; the column is the event&rsquo;s capacity.
        </p>
      ) : (
        <p className="text-xs text-[var(--text-muted)]">
          Entries taken. At least one of these events has no entry limit set, so no capacity is
          drawn for any of them.
        </p>
      )}
      {anyLoose && (
        // Named rather than silently reconciled — see the header. This is the
        // only case where these columns do not sum to the figure above them.
        <p className="text-xs text-[var(--text-muted)]">
          A doubles event counts draw slots, so two entrants still waiting for a partner make
          one slot. The total above counts each of them separately.
        </p>
      )}
    </div>
  );
}

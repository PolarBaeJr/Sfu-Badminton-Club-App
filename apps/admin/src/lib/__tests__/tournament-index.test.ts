import { describe, it, expect } from 'vitest';
import {
  capacityOf,
  disciplineLine,
  feeLabel,
  formatEventDate,
  tournamentStage,
  type IndexEvent,
} from '../tournament-index';

// The /tournaments index renders four numbers the schema does not store, and
// every one of them is a fold over rows that CAN disagree — a completed parent
// with an event still open, a tournament whose events are half capped. These
// are the disagreements, written down.

function ev(over: Partial<IndexEvent> = {}): IndexEvent {
  return {
    id: 'e1',
    tournament_id: 't1',
    event_type: 'open_singles',
    status: 'registration',
    draw_locked: false,
    max_participants: null,
    ...over,
  };
}

describe('tournamentStage', () => {
  it('lets suspension beat every event state', () => {
    expect(
      tournamentStage({ status: 'active', suspended_at: '2026-02-01T00:00:00Z' }, [ev()]),
    ).toBe('suspended');
  });

  it('lets the parent terminal states beat an event still marked open', () => {
    expect(tournamentStage({ status: 'archived' }, [ev({ status: 'registration' })])).toBe('archived');
    expect(tournamentStage({ status: 'completed' }, [ev({ status: 'registration' })])).toBe('finished');
  });

  it('calls a tournament with any bracket up "draw set", even mid-registration', () => {
    expect(
      tournamentStage({ status: 'active' }, [
        ev({ id: 'a', status: 'registration' }),
        ev({ id: 'b', status: 'bracket_generated' }),
      ]),
    ).toBe('draw-set');
  });

  it('treats a locked draw as a set draw even before the bracket is generated', () => {
    expect(tournamentStage({ status: 'active' }, [ev({ draw_locked: true })])).toBe('draw-set');
  });

  it('is open for entry while any event takes registrations or check-ins', () => {
    expect(tournamentStage({ status: 'draft' }, [ev({ status: 'checkin' })])).toBe('entries-open');
  });

  it('is finished when every event is, whatever the parent still says', () => {
    expect(tournamentStage({ status: 'active' }, [ev({ status: 'completed' })])).toBe('finished');
  });

  it('says so plainly when nothing has been scheduled', () => {
    expect(tournamentStage({ status: 'draft' }, [])).toBe('no-events');
  });
});

describe('capacityOf', () => {
  it('sums the caps when every event has one', () => {
    expect(capacityOf([ev({ id: 'a', max_participants: 16 }), ev({ id: 'b', max_participants: 16 })])).toBe(32);
  });

  // THE WHOLE POINT. max_participants is nullable, and a partial sum would put
  // a denominator on a tournament that can still take an unlimited field.
  it('refuses a denominator when any event is uncapped', () => {
    expect(capacityOf([ev({ id: 'a', max_participants: 16 }), ev({ id: 'b' })])).toBeNull();
  });

  it('has no denominator with no events at all', () => {
    expect(capacityOf([])).toBeNull();
  });
});

describe('disciplineLine', () => {
  it('collapses the seven event types to the two disciplines actually run', () => {
    expect(
      disciplineLine([ev({ id: 'a', event_type: 'mens_singles' }), ev({ id: 'b', event_type: 'mixed_doubles' })]),
    ).toBe('SINGLES + DOUBLES');
    expect(disciplineLine([ev({ event_type: 'womens_doubles' })])).toBe('DOUBLES');
    expect(disciplineLine([])).toBe('');
  });
});

describe('formatEventDate', () => {
  // A DATE column fed to `new Date()` is UTC midnight, which renders as the day
  // before anywhere west of Greenwich — and the club is in Vancouver. The
  // formatter pins timeZone:'UTC' so this assertion holds in every zone the
  // suite might run in, which is the property being fixed.
  it('renders the stored day, not the local one', () => {
    expect(formatEventDate('2026-02-07')).toBe('Sat 7 Feb');
    expect(formatEventDate('2026-01-01')).toBe('Thu 1 Jan');
  });

  it('hands back anything that is not a date rather than rendering Invalid Date', () => {
    expect(formatEventDate('')).toBe('');
  });
});

describe('feeLabel', () => {
  it('gives one amount for one tier and a range for several', () => {
    expect(feeLabel([{ amount_cents: 1500 }])).toBe('$15');
    expect(feeLabel([{ amount_cents: 1000 }, { amount_cents: 2000 }])).toBe('$10–$20');
  });

  it('says nothing when no tier has been priced', () => {
    expect(feeLabel([])).toBeNull();
  });
});

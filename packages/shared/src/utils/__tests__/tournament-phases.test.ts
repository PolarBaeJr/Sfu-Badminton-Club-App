import { describe, it, expect } from 'vitest';
import {
  isPoolToBracket,
  endsInKnockout,
  playsRoundRobin,
  statusStepsFor,
  nextStatusFor,
  currentPhase,
  phaseValueFor,
  eventIsPlaying,
  eventIsRedrawable,
  resolveMatchShape,
  hasOwnMatchShape,
  knockoutLadderShape,
  knockoutLadder,
  POOL_LADDER_SHAPE,
  TOURNAMENT_EVENT_FORMAT_LABELS,
} from '../tournament-phases';
import { eventHasDraw } from '../tournament-withdrawal';
import { getEventRules, describeMatchShape, derivedFormatWeight } from '../constants';
import type { TournamentEventFormat, TournamentEventStatus } from '../../types/database';

const FORMATS: TournamentEventFormat[] = ['single_elimination', 'round_robin', 'pool_to_bracket'];

describe('format predicates', () => {
  it('labels every format', () => {
    for (const f of FORMATS) {
      expect(TOURNAMENT_EVENT_FORMAT_LABELS[f]).toBeTruthy();
    }
    expect(Object.keys(TOURNAMENT_EVENT_FORMAT_LABELS).sort()).toEqual([...FORMATS].sort());
  });

  it('puts pool_to_bracket in BOTH camps, which is the whole point of it', () => {
    expect(endsInKnockout('pool_to_bracket')).toBe(true);
    expect(playsRoundRobin('pool_to_bracket')).toBe(true);
  });

  // THE REGRESSION 00106'S HEADER WARNED ABOUT. Every branch in the console
  // that used to read `format !== 'round_robin'` or `=== 'single_elimination'`
  // now goes through these, and the two existing formats must come out of them
  // exactly where they went in.
  it('leaves the two existing formats where they were', () => {
    expect(endsInKnockout('single_elimination')).toBe(true);
    expect(playsRoundRobin('single_elimination')).toBe(false);
    expect(endsInKnockout('round_robin')).toBe(false);
    expect(playsRoundRobin('round_robin')).toBe(true);
    expect(isPoolToBracket('single_elimination')).toBe(false);
    expect(isPoolToBracket('round_robin')).toBe(false);
  });

  it('treats a missing format as neither rather than as one of them', () => {
    for (const f of [null, undefined, '']) {
      expect(isPoolToBracket(f)).toBe(false);
      expect(endsInKnockout(f)).toBe(false);
      expect(playsRoundRobin(f)).toBe(false);
    }
  });
});

describe('the status machine', () => {
  it('leaves the five-step path untouched for the two existing formats', () => {
    for (const f of ['single_elimination', 'round_robin']) {
      expect(statusStepsFor(f)).toEqual([
        'registration', 'checkin', 'bracket_generated', 'live', 'completed',
      ]);
    }
  });

  it('inserts the pool half in the middle and changes nothing else', () => {
    expect(statusStepsFor('pool_to_bracket')).toEqual([
      'registration', 'checkin', 'pool_generated', 'pool_live', 'bracket_generated', 'live', 'completed',
    ]);
  });

  it('is forward-only and one step at a time', () => {
    for (const f of FORMATS) {
      const steps = statusStepsFor(f);
      steps.forEach((s, i) => {
        expect(nextStatusFor(f, s)).toBe(i === steps.length - 1 ? null : steps[i + 1]);
      });
    }
  });

  // A pool_to_bracket event cannot jump from check-in to a live knockout — the
  // pool is not optional, and this is what enforces it in setEventStatus.
  it('does not offer a route past the pool', () => {
    expect(nextStatusFor('pool_to_bracket', 'checkin')).toBe('pool_generated');
    expect(nextStatusFor('pool_to_bracket', 'pool_live')).toBe('bracket_generated');
  });

  it('names the current phase, and only on the format that has two', () => {
    expect(currentPhase('pool_to_bracket', 'pool_generated')).toBe('pool');
    expect(currentPhase('pool_to_bracket', 'pool_live')).toBe('pool');
    expect(currentPhase('pool_to_bracket', 'bracket_generated')).toBe('bracket');
    expect(currentPhase('pool_to_bracket', 'live')).toBe('bracket');
    expect(currentPhase('pool_to_bracket', 'completed')).toBe('bracket');
    expect(currentPhase('pool_to_bracket', 'checkin')).toBeNull();
    for (const s of statusStepsFor('single_elimination')) {
      expect(currentPhase('single_elimination', s)).toBeNull();
      expect(currentPhase('round_robin', s)).toBeNull();
    }
  });

  // A phase value written on a single-phase event would sit in a column nothing
  // reads and would have to be accounted for by 00107's uniqueness index.
  it('writes a phase only on the format that has phases', () => {
    expect(phaseValueFor('pool_to_bracket', 'pool')).toBe('pool');
    expect(phaseValueFor('pool_to_bracket', 'bracket')).toBe('bracket');
    expect(phaseValueFor('single_elimination', 'bracket')).toBeNull();
    expect(phaseValueFor('round_robin', 'pool')).toBeNull();
  });

  // THE PREDICATE THE WHOLE FORMAT DEPENDS ON. enterMatchResultImpl refuses
  // anything this says no to, so a pool at `pool_live` that did not read as
  // playing would make the format unable to record a single score.
  it('counts pool_live as playing, and nothing else new', () => {
    expect(eventIsPlaying('pool_live')).toBe(true);
    expect(eventIsPlaying('live')).toBe(true);
    for (const s of ['registration', 'checkin', 'pool_generated', 'bracket_generated', 'completed']) {
      expect(eventIsPlaying(s)).toBe(false);
    }
  });

  it('treats a drawn pool as a drawn event', () => {
    for (const s of ['pool_generated', 'pool_live', 'bracket_generated', 'live', 'completed']) {
      expect(eventHasDraw(s)).toBe(true);
    }
    for (const s of ['registration', 'checkin']) {
      expect(eventHasDraw(s)).toBe(false);
    }
  });

  it('offers a redraw in every drawn state except the finalised one', () => {
    expect(eventIsRedrawable('pool_generated')).toBe(true);
    expect(eventIsRedrawable('pool_live')).toBe(true);
    expect(eventIsRedrawable('bracket_generated')).toBe(true);
    expect(eventIsRedrawable('live')).toBe(true);
    expect(eventIsRedrawable('completed')).toBe(false);
    expect(eventIsRedrawable('checkin')).toBe(false);
  });

  // Every status the type allows must appear on exactly one format's path, or
  // an event could reach a state its own stepper cannot draw.
  it('covers every status across the three paths', () => {
    const seen = new Set<TournamentEventStatus>();
    for (const f of FORMATS) for (const s of statusStepsFor(f)) seen.add(s);
    expect([...seen].sort()).toEqual([
      'bracket_generated', 'checkin', 'completed', 'live', 'pool_generated', 'pool_live', 'registration',
    ]);
  });
});

describe('resolveMatchShape', () => {
  const event = { match_format: 'best_of_3_to_21', games_per_match: null, points_per_game: null };

  // THE SAFETY PROPERTY THAT MAKES 00108 APPLICABLE TO A LIVE TABLE: every
  // match written before it has all three columns NULL, and must resolve to
  // exactly what it resolves to today.
  it('is the event shape for a match with no overrides', () => {
    expect(resolveMatchShape(null, event)).toEqual(event);
    expect(resolveMatchShape({}, event)).toEqual(event);
    expect(resolveMatchShape({ games_per_match: null, points_per_game: null, match_format: null }, event))
      .toEqual(event);
    expect(describeMatchShape(resolveMatchShape(null, event))).toBe('Best of 3 to 21');
  });

  it('lets the match win, per field', () => {
    const shape = resolveMatchShape({ games_per_match: 1, points_per_game: 11 }, event);
    expect(getEventRules(shape)).toMatchObject({ bestOf: 1, target: 11 });
    // Only one field overridden: the other still comes from the event, the same
    // way getRulesFor composes the typed columns with the enum.
    const half = resolveMatchShape({ points_per_game: 15 }, { ...event, games_per_match: 3, points_per_game: 21 });
    expect(getEventRules(half)).toMatchObject({ bestOf: 3, target: 15 });
  });

  it('falls back through the event to the enum preset', () => {
    const shape = resolveMatchShape(null, { match_format: 'one_game_15' });
    expect(getEventRules(shape)).toMatchObject({ bestOf: 1, target: 15 });
  });

  it('knows whether a match carries its own shape', () => {
    expect(hasOwnMatchShape(null)).toBe(false);
    expect(hasOwnMatchShape({ games_per_match: null, points_per_game: null })).toBe(false);
    expect(hasOwnMatchShape({ points_per_game: 11 })).toBe(true);
    expect(hasOwnMatchShape({ match_format: 'one_game_11' })).toBe(true);
  });
});

describe('the club ladder', () => {
  // "we play round robin 11s then play single elim first round 11s, quarter 15s
  // semis 21s finals and third place games best to 3 21s"
  it('is what the club described, counted back from the final', () => {
    expect(knockoutLadderShape(0)).toEqual({ games_per_match: 3, points_per_game: 21 });
    expect(knockoutLadderShape(1)).toEqual({ games_per_match: 1, points_per_game: 21 });
    expect(knockoutLadderShape(2)).toEqual({ games_per_match: 1, points_per_game: 15 });
    expect(knockoutLadderShape(3)).toEqual({ games_per_match: 1, points_per_game: 11 });
    expect(knockoutLadderShape(9)).toEqual({ games_per_match: 1, points_per_game: 11 });
    expect(POOL_LADDER_SHAPE).toEqual({ games_per_match: 1, points_per_game: 11 });
  });

  // ANCHORING FORWARDS IS THE BUG THIS GUARDS. A 4-entry draw is semi-final
  // then final; called from round 1 forwards it would be "round 1 to 11" for
  // what is actually a semi-final.
  it('degrades correctly for a small draw', () => {
    const four = knockoutLadder(2);
    expect(four.byRound.get(1)).toEqual({ games_per_match: 1, points_per_game: 21 }); // semi-final
    expect(four.byRound.get(2)).toEqual({ games_per_match: 3, points_per_game: 21 }); // final
  });

  it('gives an 8-draw quarter/semi/final and a 32-draw two rounds of 11s', () => {
    const eight = knockoutLadder(3);
    expect(eight.byRound.get(1)).toEqual({ games_per_match: 1, points_per_game: 15 });
    expect(eight.byRound.get(2)).toEqual({ games_per_match: 1, points_per_game: 21 });
    expect(eight.byRound.get(3)).toEqual({ games_per_match: 3, points_per_game: 21 });

    const thirtyTwo = knockoutLadder(5);
    expect(thirtyTwo.byRound.get(1)).toEqual({ games_per_match: 1, points_per_game: 11 });
    expect(thirtyTwo.byRound.get(2)).toEqual({ games_per_match: 1, points_per_game: 11 });
    expect(thirtyTwo.byRound.get(3)).toEqual({ games_per_match: 1, points_per_game: 15 });
    expect(thirtyTwo.byRound.get(4)).toEqual({ games_per_match: 1, points_per_game: 21 });
    expect(thirtyTwo.byRound.get(5)).toEqual({ games_per_match: 3, points_per_game: 21 });
  });

  // The playoff shares round_number with the final and is not in the round
  // sequence, so it needs its own answer or it would silently inherit the event.
  it('gives the third-place playoff the final’s shape', () => {
    for (const rounds of [2, 3, 4, 5]) {
      expect(knockoutLadder(rounds).thirdPlace).toEqual({ games_per_match: 3, points_per_game: 21 });
    }
  });

  it('covers every round of the draw and nothing beyond it', () => {
    const { byRound } = knockoutLadder(4);
    expect([...byRound.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  // A SHORTER MATCH MUST RATE FOR LESS, or the ladder is cosmetic. No new
  // formula was added for this: derivedFormatWeight already says
  // (target / 21) x (1.25 for a best-of), and the resolved shape is what
  // applyTournamentMatchElo feeds it.
  it('rates a first round to 11 well below a best-of-3 final', () => {
    const weightOf = (r: { games_per_match: number; points_per_game: number }) => {
      const rules = getEventRules({ match_format: 'best_of_3_to_21', ...r });
      return derivedFormatWeight(rules.bestOf, rules.target);
    };
    const early = weightOf(knockoutLadderShape(3));
    const quarter = weightOf(knockoutLadderShape(2));
    const semi = weightOf(knockoutLadderShape(1));
    const final = weightOf(knockoutLadderShape(0));
    expect(early).toBeLessThan(quarter);
    expect(quarter).toBeLessThan(semi);
    expect(semi).toBeLessThan(final);
    expect(final).toBeCloseTo(1.25, 5);
  });
});

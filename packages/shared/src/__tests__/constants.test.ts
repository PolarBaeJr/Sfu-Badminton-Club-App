import { describe, it, expect } from 'vitest';
import {
  PLAYER_STATUS_LABELS,
  MATCH_FORMAT_LABELS,
  EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_MATCH_FORMAT_LABELS,
  TOURNAMENT_EVENT_STATUS_LABELS,
  TOURNAMENT_EVENT_STATUS_COLORS,
  isDoublesEvent,
  getRoundName,
  nextPowerOf2,
  getMaxGamesForFormat,
  PLACEMENT_BONUSES,
  DEFAULT_ELO,
  PROVISIONAL_THRESHOLD,
} from '../utils/constants';
import type {
  PlayerStatus,
  MatchFormat,
  EventType,
  TournamentEventType,
  TournamentMatchFormat,
  TournamentEventStatus,
} from '../types/database';

// =============================================
// Label map completeness tests
// =============================================

describe('PLAYER_STATUS_LABELS', () => {
  const allStatuses: PlayerStatus[] = ['competitive', 'recreational', 'pending_approval', 'suspended'];

  it('has an entry for every PlayerStatus value', () => {
    for (const status of allStatuses) {
      expect(PLAYER_STATUS_LABELS[status]).toBeDefined();
      expect(typeof PLAYER_STATUS_LABELS[status]).toBe('string');
      expect(PLAYER_STATUS_LABELS[status].length).toBeGreaterThan(0);
    }
  });

  it('has no extra keys beyond the defined statuses', () => {
    expect(Object.keys(PLAYER_STATUS_LABELS).sort()).toEqual([...allStatuses].sort());
  });
});

describe('MATCH_FORMAT_LABELS', () => {
  const allFormats: MatchFormat[] = ['bo3_21', 'single_21', 'single_15', 'single_11'];

  it('has an entry for every MatchFormat value', () => {
    for (const format of allFormats) {
      expect(MATCH_FORMAT_LABELS[format]).toBeDefined();
      expect(typeof MATCH_FORMAT_LABELS[format]).toBe('string');
      expect(MATCH_FORMAT_LABELS[format].length).toBeGreaterThan(0);
    }
  });

  it('has no extra keys beyond the defined formats', () => {
    expect(Object.keys(MATCH_FORMAT_LABELS).sort()).toEqual([...allFormats].sort());
  });
});

describe('EVENT_TYPE_LABELS', () => {
  const allTypes: EventType[] = ['rated_challenge', 'casual', 'tournament', 'trial', 'admin_entered'];

  it('has an entry for every EventType value', () => {
    for (const type of allTypes) {
      expect(EVENT_TYPE_LABELS[type]).toBeDefined();
      expect(typeof EVENT_TYPE_LABELS[type]).toBe('string');
      expect(EVENT_TYPE_LABELS[type].length).toBeGreaterThan(0);
    }
  });

  it('has no extra keys beyond the defined types', () => {
    expect(Object.keys(EVENT_TYPE_LABELS).sort()).toEqual([...allTypes].sort());
  });
});

describe('TOURNAMENT_EVENT_TYPE_LABELS', () => {
  const allEventTypes: TournamentEventType[] = [
    'mens_singles',
    'womens_singles',
    'open_singles',
    'mens_doubles',
    'womens_doubles',
    'mixed_doubles',
    'open_doubles',
  ];

  it('has an entry for every TournamentEventType value', () => {
    for (const type of allEventTypes) {
      expect(TOURNAMENT_EVENT_TYPE_LABELS[type]).toBeDefined();
      expect(typeof TOURNAMENT_EVENT_TYPE_LABELS[type]).toBe('string');
      expect(TOURNAMENT_EVENT_TYPE_LABELS[type].length).toBeGreaterThan(0);
    }
  });

  it('has no extra keys beyond the defined event types', () => {
    expect(Object.keys(TOURNAMENT_EVENT_TYPE_LABELS).sort()).toEqual([...allEventTypes].sort());
  });
});

describe('TOURNAMENT_MATCH_FORMAT_LABELS', () => {
  const allFormats: TournamentMatchFormat[] = ['best_of_3_to_21', 'one_game_21', 'one_game_15', 'one_game_11'];

  it('has an entry for every TournamentMatchFormat value', () => {
    for (const format of allFormats) {
      expect(TOURNAMENT_MATCH_FORMAT_LABELS[format]).toBeDefined();
      expect(typeof TOURNAMENT_MATCH_FORMAT_LABELS[format]).toBe('string');
      expect(TOURNAMENT_MATCH_FORMAT_LABELS[format].length).toBeGreaterThan(0);
    }
  });

  it('has no extra keys beyond the defined formats', () => {
    expect(Object.keys(TOURNAMENT_MATCH_FORMAT_LABELS).sort()).toEqual([...allFormats].sort());
  });
});

describe('TOURNAMENT_EVENT_STATUS_LABELS', () => {
  const allStatuses: TournamentEventStatus[] = ['registration', 'checkin', 'bracket_generated', 'live', 'completed'];

  it('has an entry for every TournamentEventStatus value', () => {
    for (const status of allStatuses) {
      expect(TOURNAMENT_EVENT_STATUS_LABELS[status]).toBeDefined();
      expect(typeof TOURNAMENT_EVENT_STATUS_LABELS[status]).toBe('string');
      expect(TOURNAMENT_EVENT_STATUS_LABELS[status].length).toBeGreaterThan(0);
    }
  });

  it('has no extra keys beyond the defined statuses', () => {
    expect(Object.keys(TOURNAMENT_EVENT_STATUS_LABELS).sort()).toEqual([...allStatuses].sort());
  });
});

describe('TOURNAMENT_EVENT_STATUS_COLORS', () => {
  const allStatuses: TournamentEventStatus[] = ['registration', 'checkin', 'bracket_generated', 'live', 'completed'];

  it('has a color entry for every TournamentEventStatus value', () => {
    for (const status of allStatuses) {
      expect(TOURNAMENT_EVENT_STATUS_COLORS[status]).toBeDefined();
      expect(TOURNAMENT_EVENT_STATUS_COLORS[status]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('has the same keys as the status labels', () => {
    expect(Object.keys(TOURNAMENT_EVENT_STATUS_COLORS).sort()).toEqual(
      Object.keys(TOURNAMENT_EVENT_STATUS_LABELS).sort()
    );
  });
});

// =============================================
// isDoublesEvent
// =============================================
describe('isDoublesEvent', () => {
  it('returns true for mens_doubles', () => {
    expect(isDoublesEvent('mens_doubles')).toBe(true);
  });

  it('returns true for womens_doubles', () => {
    expect(isDoublesEvent('womens_doubles')).toBe(true);
  });

  it('returns true for mixed_doubles', () => {
    expect(isDoublesEvent('mixed_doubles')).toBe(true);
  });

  it('returns true for open_doubles', () => {
    expect(isDoublesEvent('open_doubles')).toBe(true);
  });

  it('returns false for mens_singles', () => {
    expect(isDoublesEvent('mens_singles')).toBe(false);
  });

  it('returns false for womens_singles', () => {
    expect(isDoublesEvent('womens_singles')).toBe(false);
  });

  it('returns false for open_singles', () => {
    expect(isDoublesEvent('open_singles')).toBe(false);
  });

  it('correctly classifies every TournamentEventType', () => {
    const allTypes: TournamentEventType[] = [
      'mens_singles', 'womens_singles', 'open_singles',
      'mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles',
    ];
    const doublesCount = allTypes.filter(isDoublesEvent).length;
    const singlesCount = allTypes.filter((t) => !isDoublesEvent(t)).length;
    expect(doublesCount).toBe(4);
    expect(singlesCount).toBe(3);
  });
});

// =============================================
// getRoundName
// =============================================
describe('getRoundName', () => {
  describe('standard bracket names', () => {
    it('returns "Final" for the last round', () => {
      expect(getRoundName(4, 4)).toBe('Final');
      expect(getRoundName(1, 1)).toBe('Final');
    });

    it('returns "Semi-Final" for second-to-last round', () => {
      expect(getRoundName(3, 4)).toBe('Semi-Final');
      expect(getRoundName(2, 3)).toBe('Semi-Final');
    });

    it('returns "Quarter-Final" for third-to-last round', () => {
      expect(getRoundName(2, 4)).toBe('Quarter-Final');
      expect(getRoundName(1, 3)).toBe('Quarter-Final');
    });

    it('returns "Round of X" for earlier rounds', () => {
      expect(getRoundName(1, 4)).toBe('Round of 16');
      expect(getRoundName(1, 5)).toBe('Round of 32');
      expect(getRoundName(2, 5)).toBe('Round of 16');
    });
  });

  describe('various bracket sizes', () => {
    it('handles a 2-player bracket (1 total round)', () => {
      expect(getRoundName(1, 1)).toBe('Final');
    });

    it('handles a 4-player bracket (2 total rounds)', () => {
      expect(getRoundName(1, 2)).toBe('Semi-Final');
      expect(getRoundName(2, 2)).toBe('Final');
    });

    it('handles an 8-player bracket (3 total rounds)', () => {
      expect(getRoundName(1, 3)).toBe('Quarter-Final');
      expect(getRoundName(2, 3)).toBe('Semi-Final');
      expect(getRoundName(3, 3)).toBe('Final');
    });

    it('handles a 16-player bracket (4 total rounds)', () => {
      expect(getRoundName(1, 4)).toBe('Round of 16');
      expect(getRoundName(2, 4)).toBe('Quarter-Final');
      expect(getRoundName(3, 4)).toBe('Semi-Final');
      expect(getRoundName(4, 4)).toBe('Final');
    });

    it('handles a 32-player bracket (5 total rounds)', () => {
      expect(getRoundName(1, 5)).toBe('Round of 32');
      expect(getRoundName(2, 5)).toBe('Round of 16');
      expect(getRoundName(3, 5)).toBe('Quarter-Final');
      expect(getRoundName(4, 5)).toBe('Semi-Final');
      expect(getRoundName(5, 5)).toBe('Final');
    });
  });
});

// =============================================
// nextPowerOf2
// =============================================
describe('nextPowerOf2', () => {
  it('returns 1 for input of 0', () => {
    expect(nextPowerOf2(0)).toBe(1);
  });

  it('returns 1 for input of 1', () => {
    expect(nextPowerOf2(1)).toBe(1);
  });

  it('returns the same number when input is already a power of 2', () => {
    expect(nextPowerOf2(2)).toBe(2);
    expect(nextPowerOf2(4)).toBe(4);
    expect(nextPowerOf2(8)).toBe(8);
    expect(nextPowerOf2(16)).toBe(16);
    expect(nextPowerOf2(32)).toBe(32);
    expect(nextPowerOf2(64)).toBe(64);
  });

  it('rounds up to the next power of 2 for non-power inputs', () => {
    expect(nextPowerOf2(3)).toBe(4);
    expect(nextPowerOf2(5)).toBe(8);
    expect(nextPowerOf2(6)).toBe(8);
    expect(nextPowerOf2(7)).toBe(8);
    expect(nextPowerOf2(9)).toBe(16);
    expect(nextPowerOf2(10)).toBe(16);
    expect(nextPowerOf2(15)).toBe(16);
    expect(nextPowerOf2(17)).toBe(32);
    expect(nextPowerOf2(33)).toBe(64);
  });

  it('handles typical tournament bracket sizes', () => {
    // 6 players -> 8-player bracket
    expect(nextPowerOf2(6)).toBe(8);
    // 12 players -> 16-player bracket
    expect(nextPowerOf2(12)).toBe(16);
    // 20 players -> 32-player bracket
    expect(nextPowerOf2(20)).toBe(32);
    // 50 players -> 64-player bracket
    expect(nextPowerOf2(50)).toBe(64);
  });

  it('returns 1 for negative input', () => {
    // p starts at 1, and 1 >= any negative number, so returns 1
    expect(nextPowerOf2(-5)).toBe(1);
  });
});

// =============================================
// getMaxGamesForFormat
// =============================================
describe('getMaxGamesForFormat', () => {
  it('returns 3 for best_of_3_to_21 format', () => {
    expect(getMaxGamesForFormat('best_of_3_to_21')).toBe(3);
  });

  it('returns 1 for one_game_21 format', () => {
    expect(getMaxGamesForFormat('one_game_21')).toBe(1);
  });

  it('returns 1 for one_game_15 format', () => {
    expect(getMaxGamesForFormat('one_game_15')).toBe(1);
  });

  it('returns 1 for one_game_11 format', () => {
    expect(getMaxGamesForFormat('one_game_11')).toBe(1);
  });

  it('only best_of_3_to_21 has multiple games', () => {
    const allFormats: TournamentMatchFormat[] = ['best_of_3_to_21', 'one_game_21', 'one_game_15', 'one_game_11'];
    const multiGameFormats = allFormats.filter((f) => getMaxGamesForFormat(f) > 1);
    expect(multiGameFormats).toEqual(['best_of_3_to_21']);
  });
});

// =============================================
// Constants values
// =============================================
describe('business constants', () => {
  it('DEFAULT_ELO is 1200', () => {
    expect(DEFAULT_ELO).toBe(1200);
  });

  it('PROVISIONAL_THRESHOLD is 8 matches', () => {
    expect(PROVISIONAL_THRESHOLD).toBe(8);
  });

  it('PLACEMENT_BONUSES has separate scales for singles and doubles', () => {
    expect(PLACEMENT_BONUSES.singles).toBeDefined();
    expect(PLACEMENT_BONUSES.doubles).toBeDefined();
  });

  it('singles champion bonus is higher than doubles champion bonus', () => {
    expect(PLACEMENT_BONUSES.singles.champion).toBeGreaterThan(PLACEMENT_BONUSES.doubles.champion);
  });

  it('bonuses decrease from champion to quarterfinalist', () => {
    const { champion, finalist, semifinalist, quarterfinalist } = PLACEMENT_BONUSES.singles;
    expect(champion).toBeGreaterThan(finalist);
    expect(finalist).toBeGreaterThan(semifinalist);
    expect(semifinalist).toBeGreaterThan(quarterfinalist);
  });
});

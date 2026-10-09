import { describe, it, expect } from 'vitest';
import { uncategorisedWarning } from '../stage-controls';

describe('uncategorisedWarning', () => {
  it('counts teams still in the event with no category', () => {
    expect(uncategorisedWarning([
      { status: 'registered', team_category: null },
      { status: 'checked_in', team_category: undefined },
      { status: 'registered', team_category: 'mens' },
      { status: 'withdrawn', team_category: null },
      { status: 'disqualified', team_category: null },
    ])).toBe('2 teams have no category, so they get no head start. Set it in Participants.');
  });

  it('reads one team in the singular', () => {
    expect(uncategorisedWarning([{ status: 'no_show', team_category: null }]))
      .toBe('1 team has no category, so it gets no head start. Set it in Participants.');
  });

  it('says nothing when every team has one', () => {
    expect(uncategorisedWarning([{ status: 'registered', team_category: 'mixed' }])).toBeNull();
    expect(uncategorisedWarning([])).toBeNull();
  });
});

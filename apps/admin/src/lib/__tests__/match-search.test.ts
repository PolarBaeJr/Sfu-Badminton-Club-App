import { describe, expect, it } from 'vitest';
import { filterMatchRows, matchSearchKeys, type MatchSearchRow } from '../match-search';

function row(id: string, keys: string): MatchSearchRow<null> {
  return { id, keys, value: null };
}

describe('matchSearchKeys', () => {
  it('carries both the word and the letter for a result, so either reflex works', () => {
    expect(matchSearchKeys({ win: true, score: null, format: null, playedAt: null })).toContain('win');
    expect(matchSearchKeys({ win: true, score: null, format: null, playedAt: null })).toContain('w');
    expect(matchSearchKeys({ win: false, score: null, format: null, playedAt: null })).toContain('loss');
  });

  it('lower-cases everything so the query does not have to match case', () => {
    expect(matchSearchKeys({ win: true, score: '21-18', format: 'Mens Doubles', playedAt: 'Jan 4' })).toBe(
      'win w 21-18 mens doubles jan 4',
    );
  });

  it('renders a null as empty, never as the text "null"', () => {
    const keys = matchSearchKeys({ win: false, score: null, format: null, playedAt: null });
    expect(keys).not.toContain('null');
  });
});

describe('filterMatchRows', () => {
  const rows = [
    row('a', matchSearchKeys({ win: true, score: '21-18, 21-15', format: 'Singles', playedAt: 'Jan 4' })),
    row('b', matchSearchKeys({ win: false, score: '19-21, 15-21', format: 'Doubles', playedAt: 'Feb 9' })),
  ];

  it('returns everything for an empty or whitespace-only query', () => {
    expect(filterMatchRows(rows, '')).toHaveLength(2);
    expect(filterMatchRows(rows, '   ')).toHaveLength(2);
  });

  it('matches every term in any order', () => {
    expect(filterMatchRows(rows, 'win 21-18').map((r) => r.id)).toEqual(['a']);
    expect(filterMatchRows(rows, '21-18 win').map((r) => r.id)).toEqual(['a']);
  });

  it('requires ALL terms, not any of them', () => {
    // 'win' matches a, 'doubles' matches b — together they match neither.
    expect(filterMatchRows(rows, 'win doubles')).toHaveLength(0);
  });

  it('finds by format and by date', () => {
    expect(filterMatchRows(rows, 'doubles').map((r) => r.id)).toEqual(['b']);
    expect(filterMatchRows(rows, 'feb').map((r) => r.id)).toEqual(['b']);
  });

  it('ignores case in the query', () => {
    expect(filterMatchRows(rows, 'SINGLES').map((r) => r.id)).toEqual(['a']);
  });

  it('returns nothing when a term matches nothing', () => {
    expect(filterMatchRows(rows, 'walkover')).toHaveLength(0);
  });
});

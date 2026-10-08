import { describe, it, expect } from 'vitest';
import { seasonCreateSchema } from '../schemas';

// createSeason used to accept only { name, start_date, end_date } and insert
// exactly that. seasons.term and seasons.year are NOT NULL with no default, so
// every attempt to create a season failed with a not-null violation — a fully
// broken workflow that went unnoticed because the club has had one season,
// created before the columns existed.
describe('seasonCreateSchema', () => {
  const valid = { term: 'fall' as const, year: 2026, start_date: '2026-09-01' };

  it('accepts a season identified by term and year', () => {
    expect(seasonCreateSchema.parse(valid)).toMatchObject({ term: 'fall', year: 2026 });
  });

  it('accepts an open-ended season with no end date', () => {
    expect(seasonCreateSchema.parse(valid).end_date).toBeUndefined();
  });

  // The three the season_term enum allows, in academic-year order.
  it('accepts every real term', () => {
    for (const term of ['fall', 'spring', 'summer'] as const) {
      expect(seasonCreateSchema.parse({ ...valid, term }).term).toBe(term);
    }
  });

  it('rejects a term the database enum does not have', () => {
    expect(() => seasonCreateSchema.parse({ ...valid, term: 'winter' })).toThrow();
  });

  // The whole point: term and year are required, because the database requires
  // them and the name is derived from them.
  it('rejects input missing term or year', () => {
    expect(() => seasonCreateSchema.parse({ year: 2026, start_date: '2026-09-01' })).toThrow();
    expect(() => seasonCreateSchema.parse({ term: 'fall', start_date: '2026-09-01' })).toThrow();
  });

  // A name is no longer an input at all — it is derived by trg_set_season_name.
  // Accepting one would create a second source of truth that the trigger then
  // silently overwrites.
  it('does not carry a name through', () => {
    const parsed = seasonCreateSchema.parse({ ...valid, name: 'Totally Different' } as never);
    expect('name' in parsed).toBe(false);
  });

  it('rejects a mistyped year rather than sorting it ahead of everything forever', () => {
    expect(() => seasonCreateSchema.parse({ ...valid, year: 20226 })).toThrow();
    expect(() => seasonCreateSchema.parse({ ...valid, year: 1900 })).toThrow();
    expect(() => seasonCreateSchema.parse({ ...valid, year: 2026.5 })).toThrow();
  });
});

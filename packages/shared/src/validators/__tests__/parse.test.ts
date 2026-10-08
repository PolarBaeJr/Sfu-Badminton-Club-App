import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseOrThrow } from '../parse';
import { matchResultSchema } from '../schemas';

describe('parseOrThrow', () => {
  const schema = z.object({
    name: z.string().min(2, 'Name too short'),
    count: z.number().int(),
  });

  it('returns the parsed data on success', () => {
    expect(parseOrThrow(schema, { name: 'Alice', count: 3 })).toEqual({
      name: 'Alice',
      count: 3,
    });
  });

  it('throws an Error with the field path and first issue message', () => {
    expect(() => parseOrThrow(schema, { name: 'A', count: 3 })).toThrow(
      'name: Name too short',
    );
  });

  it('throws without a path prefix for root-level issues', () => {
    expect(() => parseOrThrow(z.string().min(1, 'Required'), 42)).toThrow(Error);
  });

  it('works with refined schemas like matchResultSchema', () => {
    expect(() =>
      parseOrThrow(matchResultSchema, {
        winner_side: 'b',
        games: [{ game_number: 1, side_a_score: 21, side_b_score: 15 }],
        completed: true,
      }),
    ).toThrow('winner_side does not match game scores');
  });
});

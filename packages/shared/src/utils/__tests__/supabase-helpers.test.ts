import { describe, it, expect } from 'vitest';
import { unwrap, unwrapMaybe } from '../supabase-helpers';

describe('unwrap', () => {
  it('returns data when present', () => {
    expect(unwrap({ data: { id: 1 }, error: null })).toEqual({ id: 1 });
  });

  it('throws the error message when error is set', () => {
    expect(() => unwrap({ data: null, error: { message: 'boom' } })).toThrow('boom');
  });

  it('prefers the error over missing data', () => {
    expect(() => unwrap({ data: { id: 1 }, error: { message: 'boom' } })).toThrow('boom');
  });

  it('throws a not-found error when data is null without an error', () => {
    expect(() => unwrap({ data: null, error: null })).toThrow('Not found');
  });
});

describe('unwrapMaybe', () => {
  it('returns data when present', () => {
    expect(unwrapMaybe({ data: [1, 2], error: null })).toEqual([1, 2]);
  });

  it('returns null when data is null without an error', () => {
    expect(unwrapMaybe({ data: null, error: null })).toBeNull();
  });

  it('throws the error message when error is set', () => {
    expect(() => unwrapMaybe({ data: null, error: { message: 'boom' } })).toThrow('boom');
  });
});

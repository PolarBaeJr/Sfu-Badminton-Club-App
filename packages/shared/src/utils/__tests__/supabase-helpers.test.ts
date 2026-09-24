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

describe('unwrap error codes', () => {
  function thrown(fn: () => unknown): { code?: string; digest?: string; message?: string } {
    try {
      fn();
    } catch (err) {
      return err as { code?: string; digest?: string; message?: string };
    }
    throw new Error('did not throw');
  }

  it('names a missing column DB-101 whatever the call site says', () => {
    const error = { code: '42703', message: 'column x does not exist' } as never;
    const err = thrown(() => unwrap({ data: null, error }, 'FEE-101'));
    expect(err.code).toBe('DB-101');
    expect(err.message).toBe('column x does not exist');
    expect(err.digest).toMatch(/^DB-101\.[a-z0-9]{8}$/);
  });

  it('names PGRST116 DB-401', () => {
    const error = { code: 'PGRST116', message: 'x' } as never;
    expect(thrown(() => unwrapMaybe({ data: null, error })).code).toBe('DB-401');
  });

  it("uses the call site's fallback for an unclassified error, DB-000 without one", () => {
    expect(thrown(() => unwrap({ data: null, error: { message: 'boom' } }, 'FEE-101')).code).toBe('FEE-101');
    expect(thrown(() => unwrap({ data: null, error: { message: 'boom' } })).code).toBe('DB-000');
  });

  it('names missing data DB-401', () => {
    const err = thrown(() => unwrap({ data: null, error: null }, 'FEE-101'));
    expect(err.code).toBe('DB-401');
    expect(err.message).toBe('Not found');
  });
});

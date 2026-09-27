import { describe, it, expect } from 'vitest';
import { AppError, isAppError, raise, tagErrorCode } from '../app-error';
import { ERROR_CODES } from '../error-codes';
import { ExpectedError, isExpectedError, dropExpectedEvent } from '../expected-error';

describe('AppError', () => {
  it('sets digest to CODE.ref', () => {
    const err = new AppError('DB-101', 'column x does not exist');
    expect(err.code).toBe('DB-101');
    expect(err.ref).toMatch(/^[a-z0-9]{8}$/);
    expect(err.digest).toBe(`DB-101.${err.ref}`);
    expect(err.message).toBe('column x does not exist');
    expect(err).toBeInstanceOf(Error);
    expect(isAppError(err)).toBe(true);
  });

  it("defaults the message to the code's title", () => {
    expect(new AppError('FEE-101').message).toBe(ERROR_CODES['FEE-101'].title);
  });

  it('keeps the cause, and is a fault unless marked expected', () => {
    const cause = { code: '42703' };
    const err = new AppError('DB-101', 'x', { cause });
    expect(err.cause).toBe(cause);
    expect(isExpectedError(err)).toBe(false);
    expect(isExpectedError(new AppError('ACC-101', 'x', { expected: true }))).toBe(true);
  });

  it('is not confused with a Postgres error, which also has a code', () => {
    expect(isAppError({ code: '42703', message: 'x' })).toBe(false);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});

describe('a coded ExpectedError', () => {
  it('carries a digest and still reads as expected', () => {
    const err = new ExpectedError('Not authenticated', 'AUTH-101');
    expect(err.digest).toBe(`AUTH-101.${err.ref}`);
    expect(err.message).toBe('Not authenticated');
    expect(isAppError(err)).toBe(true);
    expect(isExpectedError(err)).toBe(true);
  });

  it('has no digest at all without a code', () => {
    const err = new ExpectedError('Not authenticated');
    expect('digest' in err).toBe(false);
    expect(isAppError(err)).toBe(false);
  });
});

describe('raise', () => {
  it('classifies, keeps the original message and the cause', () => {
    const pg = { code: '42703', message: 'column x does not exist' };
    const err = raise('FEE-101', pg);
    expect(err.code).toBe('DB-101');
    expect(err.message).toBe('column x does not exist');
    expect(err.cause).toBe(pg);
  });

  it('uses the fallback when nothing more specific applies, and an explicit message', () => {
    const err = raise('MEM-101', { message: 'boom' }, 'Could not read your fees: boom');
    expect(err.code).toBe('MEM-101');
    expect(err.message).toBe('Could not read your fees: boom');
  });

  it('passes an AppError through unchanged', () => {
    const original = new AppError('DB-401', 'Not found');
    expect(raise('FEE-101', original)).toBe(original);
  });
});

describe('tagErrorCode', () => {
  it('tags an event with the code and ref of a coded error', () => {
    const err = new AppError('DB-101', 'column x does not exist');
    const event = tagErrorCode({ tags: { app: 'admin' } }, { originalException: err });
    expect(event.tags).toEqual({ app: 'admin', error_code: 'DB-101', error_ref: err.ref });
  });

  it('never tags the raw message, and leaves an uncoded event alone', () => {
    const event: { message: string; tags?: Record<string, unknown> } = { message: 'x' };
    expect(tagErrorCode(event, { originalException: new Error('secret row text') })).toBe(event);
    expect(tagErrorCode(event)).toBe(event);
  });

  it('composes with dropExpectedEvent the way the Sentry configs do', () => {
    const before = (e: { tags?: Record<string, unknown> }, h: { originalException?: unknown }) => {
      const kept = dropExpectedEvent(e, h);
      return kept && tagErrorCode(kept, h);
    };
    expect(before({}, { originalException: new ExpectedError('Not authenticated', 'AUTH-101') })).toBeNull();
    expect(before({}, { originalException: new AppError('DB-101') })?.tags?.error_code).toBe('DB-101');
  });
});

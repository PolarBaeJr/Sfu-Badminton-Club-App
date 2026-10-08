import { describe, it, expect, vi } from 'vitest';
import {
  ExpectedError,
  skipExpectedRequestErrors,
  dropExpectedEvent,
} from '../utils/expected-error';
import { parseOrThrow } from '../validators/parse';
import { seasonCreateSchema } from '../validators/schemas';

// The four issues these filters exist for all arrived with
// mechanism: auto.function.nextjs.on_request_error, handled: no — a server
// action that THREW its refusal rather than returning it, so no captureException
// call site was involved and nothing in runAction could see it.
//
// Every test here asserts BOTH directions on purpose. The dangerous mistake in
// this change is not "still noisy", it is "went quiet about a real fault", so a
// suite that only proved refusals are dropped would be worse than no suite.

// A stand-in for the real hook's shape: Sentry.captureRequestError takes the
// error plus a request and a context object.
const REQUEST = { path: '/seasons', method: 'POST', headers: {} };
const CONTEXT = { routerKind: 'App Router', routePath: '/seasons', routeType: 'action' };

describe('skipExpectedRequestErrors', () => {
  it('drops a refusal thrown out of a server action', () => {
    const capture = vi.fn();
    const wrapped = skipExpectedRequestErrors(capture);

    wrapped(new ExpectedError('Check-in opens at 7:00 PM'), REQUEST, CONTEXT);

    expect(capture).not.toHaveBeenCalled();
  });

  it('drops the exact rejection from the live Sentry issue', () => {
    const capture = vi.fn();
    const wrapped = skipExpectedRequestErrors(capture);

    // Not a hand-written message: the real POST /seasons path, so the test
    // breaks if parseOrThrow ever stops marking its rejections.
    let thrown: unknown;
    try {
      parseOrThrow(seasonCreateSchema, {
        term: 'fall',
        year: 1999,
        start_date: '2026-09-01',
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toMatch(/year/);

    wrapped(thrown, REQUEST, CONTEXT);
    expect(capture).not.toHaveBeenCalled();
  });

  it('still reports a genuine fault, with its arguments untouched', () => {
    const capture = vi.fn();
    const wrapped = skipExpectedRequestErrors(capture);
    const bug = new TypeError('Cannot read properties of undefined (reading id)');

    wrapped(bug, REQUEST, CONTEXT);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(bug, REQUEST, CONTEXT);
  });

  it('still reports an unmarked Error even when its text reads like a refusal', () => {
    // MARKER ONLY, and this is the test that pins it. This hook sees every
    // error from every route, so an allowlisted guard STRING is not enough to
    // stay quiet here — isExpectedFailure would return true for this message
    // inside runAction, and must not be what this filter asks.
    const capture = vi.fn();
    const wrapped = skipExpectedRequestErrors(capture);
    const guardish = new Error('Not a possible score for this format: 15-2');

    wrapped(guardish, REQUEST, CONTEXT);

    expect(capture).toHaveBeenCalledWith(guardish, REQUEST, CONTEXT);
  });

  it('reports non-Error throwables rather than swallowing them', () => {
    const capture = vi.fn();
    const wrapped = skipExpectedRequestErrors(capture);

    wrapped(null, REQUEST, CONTEXT);
    wrapped('boom', REQUEST, CONTEXT);
    wrapped({ expected: 'yes' }, REQUEST, CONTEXT); // truthy but not === true

    expect(capture).toHaveBeenCalledTimes(3);
  });

  it('passes the wrapped function return value through', () => {
    const wrapped = skipExpectedRequestErrors((_e: unknown) => 'captured');
    expect(wrapped(new Error('real'))).toBe('captured');
    expect(wrapped(new ExpectedError('refused'))).toBeUndefined();
  });
});

describe('dropExpectedEvent (beforeSend backstop)', () => {
  const event = { event_id: 'abc', exception: { values: [{ type: 'Error' }] } };

  it('drops an event whose original exception was a refusal', () => {
    expect(dropExpectedEvent(event, { originalException: new ExpectedError('Admin access required') }))
      .toBeNull();
  });

  it('keeps an event whose original exception is a genuine fault', () => {
    const hint = { originalException: new Error('connect ECONNREFUSED') };
    expect(dropExpectedEvent(event, hint)).toBe(event);
  });

  it('keeps the event unchanged when there is no hint at all', () => {
    // Events with no originalException (messages, transactions, SDK-internal
    // captures) must survive untouched — a filter that dropped these would take
    // the whole server dashboard down with it.
    expect(dropExpectedEvent(event)).toBe(event);
    expect(dropExpectedEvent(event, {})).toBe(event);
  });

  it('keeps an unmarked Error whose text reads like a refusal', () => {
    const hint = { originalException: new Error('Not a possible score for this format: 15-2') };
    expect(dropExpectedEvent(event, hint)).toBe(event);
  });
});

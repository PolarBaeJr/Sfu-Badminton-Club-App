import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExpectedError } from '@badminton/shared';

// The binding test, not the filter test — packages/shared already proves the
// predicate. This proves the app actually USES it: `export const onRequestError
// = Sentry.captureRequestError` is what shipped the noise, it is a one-line
// revert away, and nothing else in either suite would notice.
const captureRequestError = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureRequestError }));

const REQUEST = { path: '/seasons', method: 'POST', headers: {} };
const CONTEXT = { routerKind: 'App Router', routePath: '/seasons', routeType: 'action' };

describe('admin onRequestError', () => {
  beforeEach(() => captureRequestError.mockClear());

  it('does not report a refusal thrown out of a server action', async () => {
    const { onRequestError } = await import('../../instrumentation');
    // The live issue verbatim: createSeason's parseOrThrow rejection, escaping
    // the action into Next's error hook (mechanism on_request_error).
    onRequestError(
      new ExpectedError('year: Number must be greater than or equal to 2000'),
      REQUEST,
      CONTEXT,
    );
    expect(captureRequestError).not.toHaveBeenCalled();
  });

  it('still reports a genuine fault', async () => {
    const { onRequestError } = await import('../../instrumentation');
    const bug = new TypeError('adminClient.from is not a function');
    onRequestError(bug, REQUEST, CONTEXT);
    expect(captureRequestError).toHaveBeenCalledWith(bug, REQUEST, CONTEXT);
  });
});

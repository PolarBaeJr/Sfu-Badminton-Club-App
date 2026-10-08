import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExpectedError } from '@badminton/shared';

// See the admin twin: this proves the app binds the filtered hook, not
// Sentry.captureRequestError bare. Both apps have their own instrumentation.ts,
// so a fix applied to one and forgotten in the other looks identical from here
// without this file.
const captureRequestError = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureRequestError }));

const REQUEST = { path: '/checkin/abc123', method: 'POST', headers: {} };
const CONTEXT = { routerKind: 'App Router', routePath: '/checkin/[token]', routeType: 'action' };

describe('player onRequestError', () => {
  beforeEach(() => captureRequestError.mockClear());

  it('does not report a refusal thrown out of a server action', async () => {
    const { onRequestError } = await import('../../instrumentation');
    // The live issue verbatim, from sessions.ts's check-in window guard.
    onRequestError(new ExpectedError('Check-in opens at 7:00 PM'), REQUEST, CONTEXT);
    expect(captureRequestError).not.toHaveBeenCalled();
  });

  it('still reports a genuine fault', async () => {
    const { onRequestError } = await import('../../instrumentation');
    const bug = new Error('fetch failed');
    onRequestError(bug, REQUEST, CONTEXT);
    expect(captureRequestError).toHaveBeenCalledWith(bug, REQUEST, CONTEXT);
  });
});

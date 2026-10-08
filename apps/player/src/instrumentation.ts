// Next.js instrumentation hook — REQUIRED by @sentry/nextjs v8+ to initialize
// the server and edge Sentry SDKs. Without this file the server-side Sentry
// (DB spans, server traces, server-action error capture) never runs, so only
// browser events reach Sentry.
import * as Sentry from '@sentry/nextjs';
// Deep import, NOT the '@badminton/shared' barrel — see the admin twin: this
// module is bundled for the edge runtime and the barrel drags in node 'crypto'
// via email/unsubscribe, which fails the build.
import { skipExpectedRequestErrors } from '@badminton/shared/src/utils/expected-error';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

// Wrapped, not bound bare: a server action that THROWS a user-facing refusal
// ("Check-in opens at 7:00 PM", "Account pending approval") escapes into this
// hook and was filed as an unhandled fault. skipExpectedRequestErrors drops the
// ones marked ExpectedError and passes everything else straight through.
export const onRequestError = skipExpectedRequestErrors(Sentry.captureRequestError);

// Next.js instrumentation hook — REQUIRED by @sentry/nextjs v8+ to initialize
// the server and edge Sentry SDKs. Without this file the server-side Sentry
// (DB spans, server traces, server-action error capture) never runs, so only
// browser events reach Sentry.
import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;

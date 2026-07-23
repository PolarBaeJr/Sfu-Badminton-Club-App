import * as Sentry from '@sentry/nextjs';

Sentry.init({
  // Baked public DSN fallback — see sentry.server.config.ts (keeps auto-update
  // as the sole deploy path; no runtime SENTRY_DSN needed).
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  ignoreErrors: ['NEXT_NOT_FOUND'],
});

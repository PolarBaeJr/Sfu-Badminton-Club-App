import * as Sentry from '@sentry/nextjs';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabaseIntegration } from '@supabase/sentry-js-integration';

// Performance trace sample rate. Full sampling was a beta setting. On the Pi
// this instrumentation runs on the same single thread as SSR, and it measured
// as the likely cause of prod serving ~18 rps where an un-instrumented staging
// served ~28 (docs/sensitive/LOAD-TEST-2026-08-18.md).
//
// Error capture is UNAFFECTED by this — exceptions are always sent regardless
// of the trace rate. Only performance data is sampled.
//
// Override with SENTRY_TRACES_SAMPLE_RATE at build time; the default is
// what production runs.
const TRACES_RAW = process.env.SENTRY_TRACES_SAMPLE_RATE;
const tracesSampleRate =
  TRACES_RAW === undefined || TRACES_RAW === ''
    ? 0.3
    : Math.min(Math.max(Number(TRACES_RAW) || 0, 0), 1);

Sentry.init({
  // Baked public DSN fallback — see sentry.server.config.ts (keeps auto-update
  // as the sole deploy path; no runtime SENTRY_DSN needed).
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate,
  ignoreErrors: ['NEXT_NOT_FOUND'],
  integrations: [
    supabaseIntegration(SupabaseClient, Sentry, {
      tracing: true,
      breadcrumbs: true,
      errors: true,
    }),
  ],
});

import * as Sentry from '@sentry/nextjs';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabaseIntegration } from '@supabase/sentry-js-integration';
// Deep import for the same reason as instrumentation.ts — the shared barrel
// reaches node 'crypto' through email/unsubscribe, and a Sentry init file is
// loaded from places that will not tolerate that.
import { dropExpectedEvent } from '@badminton/shared/src/utils/expected-error';

// CPU profiling is a native add-on. Load defensively so a missing/incompatible
// prebuilt binary (ARM Pi, gated install scripts) degrades to "no profiling"
// instead of breaking Sentry init. See player app for the rationale.
function loadProfilingIntegration() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@sentry/profiling-node').nodeProfilingIntegration();
  } catch {
    return undefined; // native binary unavailable — span tracing still works
  }
}
const profiling = loadProfilingIntegration();

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
    ? 0.1
    : Math.min(Math.max(Number(TRACES_RAW) || 0, 0), 1);

// CPU profiling sample rate — the expensive half. profileLifecycle 'trace'
// samples the stack continuously for every traced request, and the native
// binary does load on the ARM Pi (verified in the running container), so this
// really was profiling 100% of requests.
//
// Profiling only fires on requests that are already traced, so the two rates
// multiply. We want ~1% of ALL requests profiled, so derive the session rate
// from the trace rate instead of hardcoding it — that keeps the 1% intact if
// the trace rate is ever changed. At tracesSampleRate 0.1 this resolves to
// 0.1, i.e. 0.1 x 0.1 = 1.00% of all requests.
//
// Worth raising temporarily when hunting a specific slow page.
// Override with SENTRY_PROFILES_SAMPLE_RATE at build time.
const PROFILED_SHARE_OF_ALL_REQUESTS = 0.01;
const PROFILES_RAW = process.env.SENTRY_PROFILES_SAMPLE_RATE;
const profileSessionSampleRate =
  PROFILES_RAW === undefined || PROFILES_RAW === ''
    ? Math.min(PROFILED_SHARE_OF_ALL_REQUESTS / (tracesSampleRate || 1), 1)
    : Math.min(Math.max(Number(PROFILES_RAW) || 0, 0), 1);

Sentry.init({
  // Fall back to the build-time-baked public DSN so server-side Sentry works
  // from the image alone — no runtime SENTRY_DSN env var needed. That keeps the
  // dashboard's label-based auto-update as the sole deploy path (it clones the
  // old container's env, so a runtime-only var would silently drop off).
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate,
  profileSessionSampleRate,
  profileLifecycle: 'trace',
  ignoreErrors: ['NEXT_NOT_FOUND'],
  // Backstop under instrumentation.ts's onRequestError wrapper: any other
  // automatic server-side capture path still funnels through beforeSend. Drops
  // only errors explicitly marked ExpectedError; everything else is untouched.
  beforeSend: dropExpectedEvent,
  integrations: [
    supabaseIntegration(SupabaseClient, Sentry, {
      tracing: true,
      breadcrumbs: true,
      errors: true,
    }),
    ...(profiling ? [profiling] : []),
  ],
});

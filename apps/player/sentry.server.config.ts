import * as Sentry from '@sentry/nextjs';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabaseIntegration } from '@supabase/sentry-js-integration';
// Deep import for the same reason as instrumentation.ts — the shared barrel
// reaches node 'crypto' through email/unsubscribe.
import { dropExpectedEvent } from '@badminton/shared/src/utils/expected-error';

// CPU profiling (true function-level flame graphs) is a native add-on. Load it
// defensively: if the prebuilt binary is missing or incompatible for this
// platform (e.g. the ARM Pi, or when install scripts are gated), degrade to
// "no profiling" instead of throwing and breaking Sentry init.
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
// really was profiling 100% of requests. It applies on top of the trace rate
// above, so 0.1 x 0.1 profiles ~1% of requests: enough to keep flame graphs,
// not enough to pay for on every render.
//
// Override with SENTRY_PROFILES_SAMPLE_RATE at build time.
const PROFILES_RAW = process.env.SENTRY_PROFILES_SAMPLE_RATE;
const profileSessionSampleRate =
  PROFILES_RAW === undefined || PROFILES_RAW === ''
    ? 0.1
    : Math.min(Math.max(Number(PROFILES_RAW) || 0, 0), 1);

Sentry.init({
  // Fall back to the build-time-baked public DSN so server-side Sentry works
  // from the image alone — no runtime SENTRY_DSN env var needed. That keeps the
  // dashboard's label-based auto-update as the sole deploy path (it clones the
  // old container's env, so a runtime-only var would silently drop off).
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate,
  // Continuous profiling tied to active spans; profiles attach to the trace so
  // the flame graph shows function-level CPU time. Sampled like traces.
  profileSessionSampleRate,
  profileLifecycle: 'trace',
  ignoreErrors: ['NEXT_NOT_FOUND'],
  // Backstop under instrumentation.ts's onRequestError wrapper: any other
  // automatic server-side capture path still funnels through beforeSend. Drops
  // only errors explicitly marked ExpectedError; everything else is untouched.
  beforeSend: dropExpectedEvent,
  integrations: [
    // DB span per Supabase query/RPC in server actions + SSR. Class form
    // patches the prototype -> covers per-request createServerClient and the
    // service-role client alike.
    supabaseIntegration(SupabaseClient, Sentry, {
      tracing: true,
      breadcrumbs: true,
      errors: true,
    }),
    ...(profiling ? [profiling] : []),
  ],
});

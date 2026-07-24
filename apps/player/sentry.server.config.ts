import * as Sentry from '@sentry/nextjs';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabaseIntegration } from '@supabase/sentry-js-integration';

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

Sentry.init({
  // Fall back to the build-time-baked public DSN so server-side Sentry works
  // from the image alone — no runtime SENTRY_DSN env var needed. That keeps the
  // dashboard's label-based auto-update as the sole deploy path (it clones the
  // old container's env, so a runtime-only var would silently drop off).
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1.0 /* beta: full sampling — lower after beta */,
  // Continuous profiling tied to active spans; profiles attach to the trace so
  // the flame graph shows function-level CPU time. Sampled like traces.
  profileSessionSampleRate: 1.0 /* beta: full sampling — lower after beta */,
  profileLifecycle: 'trace',
  ignoreErrors: ['NEXT_NOT_FOUND'],
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

import * as Sentry from '@sentry/nextjs';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabaseIntegration } from '@supabase/sentry-js-integration';

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

Sentry.init({
  // Fall back to the build-time-baked public DSN so server-side Sentry works
  // from the image alone — no runtime SENTRY_DSN env var needed. That keeps the
  // dashboard's label-based auto-update as the sole deploy path (it clones the
  // old container's env, so a runtime-only var would silently drop off).
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1.0 /* beta: full sampling — lower after beta */,
  profileSessionSampleRate: 1.0 /* beta: full sampling — lower after beta */,
  profileLifecycle: 'trace',
  ignoreErrors: ['NEXT_NOT_FOUND'],
  integrations: [
    supabaseIntegration(SupabaseClient, Sentry, {
      tracing: true,
      breadcrumbs: true,
      errors: true,
    }),
    ...(profiling ? [profiling] : []),
  ],
});

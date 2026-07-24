import * as Sentry from '@sentry/nextjs';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabaseIntegration } from '@supabase/sentry-js-integration';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  ignoreErrors: ['NEXT_NOT_FOUND'],
  integrations: [
    // Names every browser-side Supabase call as a DB span; class form patches
    // the prototype so all client instances are traced.
    supabaseIntegration(SupabaseClient, Sentry, {
      tracing: true,
      breadcrumbs: true,
      errors: true,
    }),
    Sentry.browserTracingIntegration({
      shouldCreateSpanForRequest: (url) => !url.startsWith(`${SUPABASE_URL}/rest`),
    }),
  ],
});

import * as Sentry from '@sentry/nextjs';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabaseIntegration } from '@supabase/sentry-js-integration';

Sentry.init({
  // Baked public DSN fallback — see sentry.server.config.ts (keeps auto-update
  // as the sole deploy path; no runtime SENTRY_DSN needed).
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1.0 /* beta: full sampling — lower after beta */,
  ignoreErrors: ['NEXT_NOT_FOUND'],
  integrations: [
    supabaseIntegration(SupabaseClient, Sentry, {
      tracing: true,
      breadcrumbs: true,
      errors: true,
    }),
  ],
});

import * as Sentry from '@sentry/nextjs';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabaseIntegration } from '@supabase/sentry-js-integration';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1.0 /* beta: full sampling — lower after beta */,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  ignoreErrors: [
    'NEXT_NOT_FOUND',
    // Injected by link-scanning extensions and mail-client webviews (Outlook
    // Safe Links is the one we see), not by anything in this app. It arrives as
    // an unhandled rejection on whatever page the member opened from a link.
    /Object Not Found Matching Id:/,
  ],
  integrations: [
    // Names every browser-side Supabase call as a DB span so the flame graph
    // shows which query/RPC is slow (not just that a request was slow).
    // Class form patches the prototype -> covers all client instances.
    supabaseIntegration(SupabaseClient, Sentry, {
      tracing: true,
      breadcrumbs: true,
      errors: true,
    }),
    // Skip the generic http.client span for Supabase REST calls — the
    // integration above already covers them, avoiding double-counted spans.
    Sentry.browserTracingIntegration({
      shouldCreateSpanForRequest: (url) => !url.startsWith(`${SUPABASE_URL}/rest`),
    }),
  ],
  beforeSend(event) {
    // Tag with player ID if available in the Sentry scope
    return event;
  },
});

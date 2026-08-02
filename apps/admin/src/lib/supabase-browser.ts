import { createBrowserClient } from '@supabase/ssr';
import { AUTH_COOKIE_NAME } from '@badminton/shared';

// NOTE: typed clients are deliberately off here — see supabase-server.ts.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    // Must match the server clients exactly — see AUTH_COOKIE_NAME.
    { cookieOptions: { name: AUTH_COOKIE_NAME } }
  );
}

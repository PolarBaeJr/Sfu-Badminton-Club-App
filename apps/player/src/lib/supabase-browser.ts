import { createBrowserClient } from '@supabase/ssr';

// NOTE: typed clients are deliberately off here — see supabase-server.ts.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

import { AppState } from 'react-native';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@badminton/shared/src/types/database.gen';
import { secureSessionStorage } from '../auth/secure-store';

export type MobileClient = SupabaseClient<Database>;

/**
 * The app's one Supabase client: a member's JWT, RLS as the gate, exactly the
 * footing the player web app's browser client has.
 *
 * detectSessionInUrl is off because there is no URL: sign-in is a code typed
 * into the app, never a link that lands here.
 */
export function createMobileClient(url: string, anonKey: string): MobileClient {
  const client = createClient<Database>(url, anonKey, {
    auth: {
      storage: secureSessionStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  // The refresh timer is a JS interval, which the OS suspends in the
  // background. Stopping it there and restarting on return refreshes a token
  // that expired while the app was away before the first request uses it.
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void client.auth.startAutoRefresh();
    else void client.auth.stopAutoRefresh();
  });

  return client;
}

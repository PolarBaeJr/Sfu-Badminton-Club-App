import { createClient } from '@supabase/supabase-js';
import { getServerSupabaseUrl } from '@badminton/shared';

// The two GoTrue-facing clients Discord /signup needs, in a module of their own
// so a test can replace both without standing up GoTrue.
//
// NEITHER PERSISTS A SESSION. There is no cookie jar on a route the bot calls,
// and a session that outlived the request would be a member's credential
// sitting in server memory. The access token lives for one verify call: it
// builds the member client, the onboarding runs, and the session is signed out.

const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

/** The anon key, no session: sends and verifies the emailed code. */
export function createSignupAuthClient() {
  return createClient(getServerSupabaseUrl(), process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: NO_SESSION,
  });
}

/**
 * A client acting AS the member whose code was just verified, so every write
 * onboarding makes is judged by the same RLS and triggers the web's are.
 */
export function createSignupMemberClient(accessToken: string) {
  return createClient(getServerSupabaseUrl(), process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: NO_SESSION,
  });
}

// SIGN-OUT SCOPES. auth-js defaults signOut() to `global`, which revokes every
// session the user holds, on every device and in both apps. So every caller
// names its scope through one of these three.
//
// The console and the member app share one auth cookie per browser, so "this
// device" means both apps in this browser.
//
// Deliberately dependency-free apart from ./constants, so a client component
// can import it deeply without pulling the shared barrel.

import { clearHostOnlyAuthCookies } from './constants';

type SignOutScope = 'local' | 'global' | 'others';

// Minimal structural shape so any Supabase auth client in this repo fits.
type AuthLike = { signOut(options: { scope: SignOutScope }): Promise<{ error: unknown }> };

/** Ends the session in this browser only. */
export async function signOutThisDevice(auth: AuthLike): Promise<{ error: unknown }> {
  const { error } = await auth.signOut({ scope: 'local' });
  // See clearHostOnlyAuthCookies: signOut alone can leave a pre-migration
  // host-only cookie behind, which would still read as a live session.
  clearHostOnlyAuthCookies();
  return { error };
}

/** Revokes every session the user holds, this browser included. */
export async function signOutEverywhere(auth: AuthLike): Promise<{ error: unknown }> {
  const { error } = await auth.signOut({ scope: 'global' });
  clearHostOnlyAuthCookies();
  return { error };
}

/**
 * Revokes every session but this one. Clears no cookies: this browser stays
 * signed in, and a failed revoke comes back as `error` with it untouched.
 */
export async function signOutOtherDevices(auth: AuthLike): Promise<{ error: unknown }> {
  const { error } = await auth.signOut({ scope: 'others' });
  return { error };
}

import { getServerSupabaseUrl } from '@badminton/shared';

/**
 * A signed storage URL, moved onto the origin a BROWSER can actually reach.
 *
 * WHY THIS IS NEEDED AT ALL. Every server-side Supabase client in this app is
 * built with getServerSupabaseUrl(), which on production is
 * SUPABASE_INTERNAL_URL: a tailnet address that resolves only inside the app's
 * own network. createSignedUrl() builds its URL by concatenating onto whatever
 * origin its client was constructed with, so a URL signed on prod points at a
 * hostname a member's phone cannot look up. Handed to a browser it fails as a
 * broken image, for a reason nothing in any log would explain.
 *
 * WHY IT IS A SEPARATE, TESTABLE FUNCTION. The rewrite is invisible on staging
 * and on localhost: SUPABASE_INTERNAL_URL is unset there, so getServerSupabaseUrl()
 * returns the public origin, the `startsWith` guard below is trivially true, and
 * the whole function is the identity. A broken rewrite therefore passes every
 * manual check anybody can do before release and fails only on prod. Driving it
 * in a browser cannot prove this; setting the variable in a test can.
 *
 * THE `startsWith` GUARD IS LOAD-BEARING IN BOTH DIRECTIONS. It is what makes
 * the unset case an exact identity rather than a string operation that happens
 * to be harmless, and it is what stops a URL already on the public origin being
 * rewritten a second time.
 *
 * DELIBERATELY A SECOND COPY of signScreenshot's rewrite in the player app
 * (app/api/discord/feedback-relay/route.ts). The two are byte for byte the same
 * three lines, including the single-slash trim, and they are left that way on
 * purpose: that one hands a URL to the Discord bot and this one hands one to a
 * browser, they are in different apps, and folding them together would mean a
 * change made for one silently retargeting the other. Kept here so the console's
 * copy is the one under test.
 */
export function browserReachableSignedUrl(signedUrl: string): string {
  const internal = getServerSupabaseUrl();
  const publicBase = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (publicBase && signedUrl.startsWith(internal)) {
    return publicBase.replace(/\/$/, '') + signedUrl.slice(internal.replace(/\/$/, '').length);
  }
  return signedUrl;
}

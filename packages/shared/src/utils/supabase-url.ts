// Which Supabase origin SERVER-side code should call.
//
// There is only one Supabase URL in this app and it is NEXT_PUBLIC_SUPABASE_URL
// -- the PUBLIC origin, https://sfubadminton.com/supabase. That is correct and
// unavoidable for the browser, which can only reach Supabase the public way. But
// server code inside a container was reusing the same literal, so every
// `getUser()` in middleware left the container, went out to Cloudflare, came
// back in through whichever host currently owns the public entrance, and only
// then reached kong on the Pi.
//
// WHY THAT STOPPED BEING SURVIVABLE. The hairpin is old; its LENGTH is not. When
// the Pi was the entrance the loop closed on the Pi itself. Once the entrance
// moved to the Mac mini the path became Pi -> Cloudflare -> mini -> peer hop ->
// Pi, which put a second host on the critical path of the first host's own auth
// check. A five-second blip at the mini therefore made the Pi's middleware
// unable to validate a session it was holding a perfectly good cookie for, and
// the outer catch redirected to /login. Members read that as "it logged me out";
// the session was never touched, and the next refresh landed on the dashboard.
//
// api/health/ready/route.ts predicted exactly this in a comment, and called it:
// "if the edge or the proxy itself degrades, every badminton backend fails this
// probe at once even though the app and the database are both fine".
//
// SUPABASE_INTERNAL_URL is deliberately NOT prefixed NEXT_PUBLIC_. Next inlines
// NEXT_PUBLIC_* at BUILD time, in server code too, so a public-prefixed value
// would be frozen into the image and could never be corrected by an env change.
// Verified in the shipped bundle: .next/server/src/middleware.js still contains
// a literal `process.env.ADMIN_PASSKEY_COOKIE_SECRET` -- a runtime read -- while
// NEXT_PUBLIC_SUPABASE_URL does not appear at all, having been substituted. So a
// non-public name here is read at runtime, including inside Edge middleware, and
// can be set on a running service without a rebuild.
//
// SAFE FOR SESSIONS. supabase-js derives its cookie name from the URL's first
// hostname label, so changing this would normally rename sb-badminton-auth-token
// and sign every member out. It cannot here: all eight server clients pass
// cookieOptions with the name pinned to AUTH_COOKIE_NAME. See constants.ts.
//
// NOT for anything the browser will see. Redirect targets, storage/avatar URLs
// and links in email must stay on the public origin -- an address on the tailnet
// is unreachable from a member's phone.

/**
 * The Supabase origin for server-to-server calls: SUPABASE_INTERNAL_URL when it
 * is set and parses, otherwise the public origin.
 *
 * The fallback is the whole safety story. An unset, empty or malformed value
 * leaves behaviour exactly as it was rather than taking auth down, which means
 * this can be rolled out to one service at a time and rolled back by clearing a
 * variable.
 */
export function getServerSupabaseUrl(): string {
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const internal = process.env.SUPABASE_INTERNAL_URL?.trim();
  if (!internal) return publicUrl!;

  try {
    const parsed = new URL(internal);
    // Anything that is not http(s) would fail later and further away, inside
    // supabase-js, as an error that says nothing about this variable.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`protocol ${parsed.protocol}`);
    }
  } catch (err) {
    // Warn, do not throw: a bad value must not be able to lock anyone out of a
    // console whose whole job is to let an admin fix things like this.
    console.warn(
      `SUPABASE_INTERNAL_URL is set but unusable (${String(err)}); falling back to the public origin`
    );
    return publicUrl!;
  }

  // No trailing slash: callers concatenate paths onto this.
  return internal.replace(/\/+$/, '');
}

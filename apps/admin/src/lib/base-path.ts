/**
 * The console's mount point, and how to build URLs that survive it.
 *
 * The console is served at sfubadminton.com/admin — the player app's origin,
 * not a subdomain of it. It moved because the player app is an installed PWA
 * and a PWA cannot keep a cross-origin navigation in its own window: linking
 * execs to admin.sfubadminton.com threw them into a browser tab every time they
 * opened the console, which they do constantly while checking members in at the
 * door.
 *
 * Next applies `basePath` to <Link>, to server-side routing, and to the router.
 * It does NOT touch raw strings — `fetch('/api/x')`, `window.location.href =
 * '/login'`, or a `redirectTo` assembled from `window.location.origin` all miss
 * the prefix. Same origin makes that worse, not better: an unprefixed path is
 * not a 404 here, it is a live route on the PLAYER app, a different container.
 * Every such string has to go through withBase().
 *
 * NEXT_PUBLIC_BASE_PATH is read at BUILD time (it is inlined into the client
 * bundle, like every NEXT_PUBLIC_* var); setting it in the Pi's runtime .env
 * does nothing. Keep this module free of Node-only imports — the Edge
 * middleware pulls it in via lib/passkey/config.
 */

/** '/admin' in every deployed build; '' when the console is root-mounted (localhost). */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

/**
 * Prefix an app-absolute path ('/dashboard', '/api/passkey/...') with the
 * basePath. Use for anything Next will not prefix on its own.
 */
export function withBase(path: string): string {
  return `${BASE_PATH}${path}`;
}

/**
 * The console's public base URL, INCLUDING the path prefix —
 * 'https://sfubadminton.com/admin'.
 *
 * NEXT_PUBLIC_ADMIN_URL is the full public base, prefix and all. That is also
 * what keeps getExpectedOrigin() in lib/passkey/config correct without any
 * special-casing: a WebAuthn origin drops the path, so the /admin here still
 * yields 'https://sfubadminton.com'. Only the fallback, used when the var is
 * unset, has to add the prefix itself.
 */
export function adminBaseUrl(fallbackOrigin: string): string {
  const configured = process.env.NEXT_PUBLIC_ADMIN_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return `${fallbackOrigin}${BASE_PATH}`;
}

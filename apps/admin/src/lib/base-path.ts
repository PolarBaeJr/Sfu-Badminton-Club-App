/**
 * The console's mount point, and how to build URLs that survive it.
 *
 * The admin console ships as TWO containers from one source: one at the root of
 * admin.sfubadminton.com (NEXT_PUBLIC_BASE_PATH unset) and one under
 * sfubadminton.com/admin (NEXT_PUBLIC_BASE_PATH=/admin), so execs opening the
 * console from the installed player PWA stay in the PWA instead of being thrown
 * into a browser tab by a cross-origin navigation.
 *
 * Next applies `basePath` to <Link>, to server-side routing, and to the router.
 * It does NOT touch raw strings — `fetch('/api/x')`, `window.location.href =
 * '/login'`, or a `redirectTo` assembled from `window.location.origin` all miss
 * the prefix and land on the PLAYER app, which is a different container. Every
 * such string has to go through withBase().
 *
 * NEXT_PUBLIC_BASE_PATH is read at BUILD time (it is inlined into the client
 * bundle, like every NEXT_PUBLIC_* var); setting it in the Pi's runtime .env
 * does nothing. Keep this module free of Node-only imports — the Edge
 * middleware pulls it in via lib/passkey/config.
 */

/** '' on the subdomain build, '/admin' on the path-mounted build. */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

/**
 * Prefix an app-absolute path ('/dashboard', '/api/passkey/...') with the
 * basePath. Use for anything Next will not prefix on its own.
 */
export function withBase(path: string): string {
  return `${BASE_PATH}${path}`;
}

/**
 * The console's public base URL, INCLUDING any path prefix — e.g.
 * 'https://admin.sfubadminton.com' or 'https://sfubadminton.com/admin'.
 *
 * NEXT_PUBLIC_ADMIN_URL is the full public base of whichever container this is,
 * so on the path build it already carries '/admin' (which is also what makes
 * getExpectedOrigin() in lib/passkey/config come out right — a WebAuthn origin
 * drops the path). Only the fallback, used when the var is unset, has to add
 * the prefix itself.
 */
export function adminBaseUrl(fallbackOrigin: string): string {
  const configured = process.env.NEXT_PUBLIC_ADMIN_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return `${fallbackOrigin}${BASE_PATH}`;
}

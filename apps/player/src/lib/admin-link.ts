/**
 * Where the "Exec Panel" links point, and whether that leaves this origin.
 *
 * The player app is an installed PWA. A cross-origin navigation cannot stay in
 * the PWA window — tapping a link to https://admin.sfubadminton.com throws the
 * exec out into a browser tab, which matters because they do it repeatedly
 * while checking members in at the door.
 *
 * The console is therefore also served same-origin at /admin (a second
 * container of the same app, built with NEXT_PUBLIC_BASE_PATH=/admin). Set
 * NEXT_PUBLIC_ADMIN_PATH=/admin to send execs there; leave it unset and the
 * links keep pointing at NEXT_PUBLIC_ADMIN_URL exactly as before, so a build
 * that has not been given the second container behaves like today.
 *
 * Build-time, like every NEXT_PUBLIC_* var — it is inlined into the bundle.
 */
export const ADMIN_PANEL_HREF =
  process.env.NEXT_PUBLIC_ADMIN_PATH || process.env.NEXT_PUBLIC_ADMIN_URL || '/admin';

/**
 * True when the href carries a scheme, i.e. it may leave this origin.
 *
 * Callers use this to decide target="_blank": opening a new tab is the point
 * for a cross-origin console, and is exactly the ejection we are trying to
 * avoid for a same-origin one.
 */
export const ADMIN_PANEL_IS_EXTERNAL = /^[a-z][a-z0-9+.-]*:/i.test(ADMIN_PANEL_HREF);

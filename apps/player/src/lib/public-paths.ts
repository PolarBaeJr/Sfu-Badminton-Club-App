// Which paths the sign-in gate lets through without a session.
//
// Extracted from middleware.ts so it can be tested directly. It used to be an
// inline boolean chain, which meant the one thing worth asserting — that a
// machine caller with its own credential is not redirected to a login page —
// could only be checked by running the whole edge middleware with a mocked
// Supabase client. It was not checked, and /api/discord/* shipped behind the
// gate: the bot would have followed the 307 to /login, received HTML under a
// 200, and failed parsing it as JSON.

/**
 * True when `pathname` is reachable without a session.
 *
 * Two kinds of entry live here and they are worth telling apart:
 *
 *  - PAGES anyone may read (`/`, `/legal`, `/leaderboard`).
 *  - ROUTES THAT CARRY THEIR OWN CREDENTIAL — a signed token, a bearer secret,
 *    a passkey challenge. These are not "public" in the sense of unprotected;
 *    they are protected by something the session gate cannot see, and putting
 *    them behind it turns a 401 into an HTML redirect the caller cannot read.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/exec') ||
    // Legal documents (terms, privacy, waiver, conduct) are public reading.
    pathname.startsWith('/legal') ||
    // ICS feed for calendar clients — token-authenticated, no session cookie.
    pathname.startsWith('/api/calendar') ||
    // One-click unsubscribe. Authenticated by the signed token in the link, not
    // by a session — and it MUST work without one. RFC 8058 is a machine POST
    // from the mail client with no cookies at all, and a mail client treats any
    // non-2xx as a failed unsubscribe, which pushes the recipient toward the
    // spam button instead.
    pathname.startsWith('/unsubscribe') ||
    // Tournament check-in QR. Someone scanning at the door may well be logged
    // out; the page itself requires a session before it changes anything.
    pathname.startsWith('/tournaments/checkin') ||
    // Passkey sign-in. Necessarily reachable without a session — completing it
    // is what creates one. Only the /login pair; /register still needs one.
    pathname.startsWith('/api/passkey/login') ||
    // The Discord bot's surface. It authenticates as a SERVICE (constant-time
    // bearer compare in isAuthorizedDiscordService, which fails closed when the
    // secret is unset) and has no session cookie at all.
    //
    // Trailing slash so /api/discordfoo can never match, same as api/health/.
    // API ONLY: /link/<token> is a PAGE and must stay gated — needing a session
    // is the entire point of it.
    pathname.startsWith('/api/discord/') ||
    pathname === '/leaderboard'
  );
}

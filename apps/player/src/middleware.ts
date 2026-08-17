import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
// Deep import, not the '@badminton/shared' barrel: the barrel re-exports the
// whole package and pulling it into the middleware bundle — which runs on every
// request — grew it from 208 kB to 371 kB. constants.ts has no dependencies.
import {
  CHECKIN_TOKEN_REGEX,
  AUTH_COOKIE_OPTIONS,
  hostOnlyAuthCookieClears,
  duplicateAuthCookieClears,
} from '@badminton/shared/src/utils/constants';

export async function middleware(request: NextRequest) {
  // Container health probes, before anything else — before the Supabase client
  // is even built. The matcher at the bottom already excludes them, so this is
  // the second of two independent guards, and it is worth the duplication: if
  // that lookahead is ever mis-edited, every container reports unhealthy at
  // once. Not in the isPublic list below either, because that list still pays
  // for an auth.getUser() round trip on a route that must stay dependency-free.
  //
  // Trailing slash so /api/healthfoo can never match.
  if (request.nextUrl.pathname.startsWith('/api/health/')) {
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({ request });

  // Stale host-only auth cookies left over from before the cookie became
  // domain-scoped. Computed from the raw header (request.cookies hides the
  // duplicate) and appended to whichever response we end up returning —
  // including the redirects below, which replace supabaseResponse entirely.
  const staleClears = duplicateAuthCookieClears(request.headers.get('cookie'));
  const finish = <T extends NextResponse>(response: T): T => {
    staleClears.forEach((c) => response.headers.append('set-cookie', c));
    return response;
  };

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options as any)
          );
          // Appended as raw headers, not via .cookies.set: ResponseCookies is
          // keyed by name alone and the second set would clobber the first.
          hostOnlyAuthCookieClears(cookiesToSet).forEach((c) =>
            supabaseResponse.headers.append('set-cookie', c)
          );
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  // Public routes viewable without an account.
  const pathname = request.nextUrl.pathname;
  const isPublic =
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
    // spam button instead. On SES a complaint rate is what suspends sending, so
    // gating this behind /login defeats the entire point of the feature.
    pathname.startsWith('/unsubscribe') ||
    // Tournament check-in QR. Someone scanning at the door may well be
    // logged out; the page itself requires a session before it changes
    // anything, so letting it render is safe and avoids a dead redirect.
    pathname.startsWith('/tournaments/checkin') ||
    // Passkey sign-in. Necessarily reachable without a session — completing it
    // is what creates one. Only the /login pair is public; the /register pair
    // below it still requires a session, since enrolling a passkey must be
    // bound to an account you have already proven you own.
    pathname.startsWith('/api/passkey/login') ||
    pathname === '/leaderboard';

  // A scanned session QR points at /checkin/<token>, which is not public — so
  // this redirect is what a signed-out scanner actually hits, before the page
  // itself ever runs. Rewriting the path without the token dropped it, leaving
  // the scanner on /feed after sign-in and making the ?checkin= chain that
  // /login, /auth/callback and /auth/post-login all implement unreachable.
  // Only a well-formed token travels, so nothing arbitrary can ride along.
  const checkinToken = pathname.match(/^\/checkin\/([^/]+)$/)?.[1];
  const checkinSuffix =
    checkinToken && CHECKIN_TOKEN_REGEX.test(checkinToken) ? `?checkin=${checkinToken}` : '';

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = checkinSuffix;
    return finish(NextResponse.redirect(url));
  }

  // Onboarding gate. onboarding_completed was read by `/` alone, so anyone who
  // had not finished setup could still reach the app: signing in lands on
  // /feed, and the installed PWA opens there too (manifest start_url), neither
  // of which passes through `/`. Checking here covers every entry point.
  //
  // API routes are exempt on purpose — they authenticate themselves, and
  // redirecting one would hand the caller an HTML page under a 200.
  //
  // players_self, not players: migration 00032 revoked blanket SELECT on the
  // table, and the view is already scoped to the caller's own row.
  if (user && !isPublic && !pathname.startsWith('/onboarding') && !pathname.startsWith('/api/')) {
    const { data: self, error } = await supabase
      .from('players_self')
      .select('onboarding_completed')
      .maybeSingle();

    // Fail OPEN on a query error. A gate that fails closed would strand every
    // member on /onboarding if the view were ever unavailable; an un-onboarded
    // player slipping through is the far cheaper failure.
    if (error) {
      console.error('Onboarding gate check failed (failing open):', error.message);
    } else if (!self?.onboarding_completed) {
      const url = request.nextUrl.clone();
      url.pathname = '/onboarding';
      // Same reasoning as the sign-in redirect above: a member who scans the QR
      // before finishing setup should still end up checked in, not stranded.
      url.search = checkinSuffix;
      return finish(NextResponse.redirect(url));
    }
  }

  return finish(supabaseResponse);
}

export const config = {
  // PWA assets (manifest, service worker, icons) must stay public —
  // an auth redirect here breaks installability and SW registration.
  //
  // api/health/ likewise: the container healthcheck runs inside the container
  // with no session, so a gated probe would 307 to /login and — since the check
  // now requires exactly 200 — mark a perfectly good container unhealthy.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|icon-192.png|icon-512.png|apple-touch-icon.png|email/|api/health/).*)',
  ],
};

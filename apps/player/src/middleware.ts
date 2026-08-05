import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
// Deep import, not the '@badminton/shared' barrel: the barrel re-exports the
// whole package and pulling it into the middleware bundle — which runs on every
// request — grew it from 208 kB to 371 kB. constants.ts has no dependencies.
import { CHECKIN_TOKEN_REGEX, AUTH_COOKIE_NAME } from '@badminton/shared/src/utils/constants';

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: { name: AUTH_COOKIE_NAME },
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
    return NextResponse.redirect(url);
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
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}

export const config = {
  // PWA assets (manifest, service worker, icons) must stay public —
  // an auth redirect here breaks installability and SW registration.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|icon-192.png|icon-512.png|apple-touch-icon.png|email/).*)',
  ],
};

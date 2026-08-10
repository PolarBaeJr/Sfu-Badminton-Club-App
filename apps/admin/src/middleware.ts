import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { canAccess, UNRESTRICTED, type AccessLevel } from '@/lib/permissions';
import { PASSKEY_VERIFIED_COOKIE } from '@/lib/passkey/config';
import { verifyPayload } from '@/lib/passkey/cookie';
import {
  AUTH_COOKIE_OPTIONS,
  hostOnlyAuthCookieClears,
  duplicateAuthCookieClears,
} from '@badminton/shared/src/utils/constants';

export async function middleware(request: NextRequest) {
  // Passkey SIGN-IN is let through before anything else, including before the
  // Supabase client is built. Two reasons it can't just join isPublicRoute
  // below:
  //   1. It has no session by definition — it is how you get one.
  //   2. The catch at the bottom of this function redirects to /login WITHOUT
  //      consulting isPublicRoute, so any blip in auth.getUser() would 307 these
  //      endpoints to the login page. fetch() follows redirects silently, so the
  //      browser would hand login-page HTML to startAuthentication() and report
  //      a cheerful 200 — the same trap /api/cron fell into (see below).
  // Trailing slash so a route like /api/passkey/loginfoo can never match. The
  // enrol (/register) and step-up (/auth) endpoints deliberately stay behind the
  // session check: those are second factors, not ways in.
  if (request.nextUrl.pathname.startsWith('/api/passkey/login/')) {
    return NextResponse.next();
  }

  // Inbound webhooks get the same treatment, for the same second reason. SNS
  // presents no session cookie, so /admin/api/webhooks/ses answered every POST
  // with a 307 to /admin/login — SNS could not even complete subscription
  // confirmation, so no bounce or complaint was ever recorded and the SES
  // complaint rate climbed unseen. isPublicRoute alone would not be enough:
  // the catch at the bottom redirects to /login without consulting it, so a
  // blip in auth.getUser() would silently un-fix this. Each handler under
  // /api/webhooks authenticates its own caller (the SES route verifies the
  // Amazon signature and pins the topic ARN, failing closed on both).
  // Trailing slash so a route like /api/webhooksfoo can never match. Skipping
  // finish() here also skips the stale-cookie cleanup, deliberately: a webhook
  // caller has no cookie jar to tidy.
  if (request.nextUrl.pathname.startsWith('/api/webhooks/')) {
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({ request });

  // See the identical block in the player middleware: expires host-only auth
  // cookies left behind when the cookie became domain-scoped, on whichever
  // response this function returns.
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
          // Raw append, not .cookies.set: ResponseCookies is keyed by name
          // alone and would clobber the domain-scoped write above.
          hostOnlyAuthCookieClears(cookiesToSet).forEach((c) =>
            supabaseResponse.headers.append('set-cookie', c)
          );
        },
      },
    }
  );

  const isPublicRoute =
    request.nextUrl.pathname.startsWith('/login') ||
    request.nextUrl.pathname.startsWith('/auth') ||
    // Scheduled jobs carry a shared secret, not a session cookie. Without this
    // the middleware redirected them to /login — and because pg_net follows
    // redirects, the cron job recorded a cheerful 200 (the login page HTML)
    // while no reminder was ever sent. Each handler under /api/cron checks the
    // secret itself and answers 401/503 when it is wrong or unset.
    request.nextUrl.pathname.startsWith('/api/cron') ||
    request.nextUrl.pathname === '/unauthorized' ||
    request.nextUrl.pathname === '/unavailable';

  try {
    const { data: { user } } = await supabase.auth.getUser();

    if (!user && !isPublicRoute) {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      return finish(NextResponse.redirect(url));
    }

    if (user && !isPublicRoute) {
      const { data: level } = await supabase.rpc('admin_access_level', { p_user_id: user.id });
      const accessLevel = (level as AccessLevel | null) ?? null;

      // UNRESTRICTED, not a second round trip: nothing narrows anybody yet.
      // Per-person permissions are stored from the next migration onwards, and
      // until then every row resolves to its level's baseline — which is a
      // transcription of what that level could already do, so this is the same
      // decision the console has always made.
      if (!canAccess(accessLevel, UNRESTRICTED, request.nextUrl.pathname)) {
        const url = request.nextUrl.clone();
        url.pathname = '/unauthorized';
        return finish(NextResponse.redirect(url));
      }

      // Passkey gate: once a user has enrolled a passkey, every page needs a
      // valid signed verified-cookie (zero passkeys = grace period). The
      // /api/passkey handlers are exempt — they're how you GET verified.
      // Wrapped in its own try so an RPC failure (e.g. migration 00011 not
      // yet applied) fails OPEN and logs, instead of falling into the outer
      // catch's redirect-to-/login (which would loop forever).
      const pathname = request.nextUrl.pathname;
      if (!pathname.startsWith('/unavailable') && !pathname.startsWith('/api/passkey')) {
        try {
          const token = request.cookies.get(PASSKEY_VERIFIED_COOKIE)?.value;
          const payload = token ? await verifyPayload(token) : null;
          if (!payload || payload.sub !== user.id) {
            const { data: hasKeys, error } = await supabase.rpc('has_passkeys', { p_user_id: user.id });
            if (error) throw new Error(error.message);
            if (hasKeys) {
              const url = request.nextUrl.clone();
              url.pathname = '/unavailable';
              url.search = '';
              url.searchParams.set('next', pathname + request.nextUrl.search);
              return finish(NextResponse.redirect(url));
            }
            // No enrolled passkeys → grace period, proceed.
          }
        } catch (err) {
          console.error('Passkey gate check failed (failing open):', err);
        }
      }
    }
  } catch {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return finish(NextResponse.redirect(url));
  }

  return finish(supabaseResponse);
}

export const config = {
  // PWA assets (manifest, icons) must stay public — an auth redirect here
  // breaks installability. The player app has carried this exclusion list since
  // it shipped; the console never got one, so /admin/manifest.json and
  // /admin/icon-*.png all 307'd to /admin/login. That was invisible only while
  // the console's <head> pointed at the origin root (i.e. at the PLAYER app's
  // assets) — fixing that without this turns a cosmetic mix-up into a console
  // that cannot be installed at all.
  //
  // Paths here are basePath-RELATIVE: Next strips /admin before matching.
  // No sw.js entry: the console registers no service worker (see app/layout.tsx).
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|icon-192.png|icon-512.png|apple-touch-icon.png).*)',
  ],
};

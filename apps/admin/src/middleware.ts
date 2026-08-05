import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { canAccess, type AccessLevel } from '@/lib/permissions';
import { PASSKEY_VERIFIED_COOKIE } from '@/lib/passkey/config';
import { verifyPayload } from '@/lib/passkey/cookie';
import {
  AUTH_COOKIE_OPTIONS,
  hostOnlyAuthCookieClears,
  duplicateAuthCookieClears,
} from '@badminton/shared/src/utils/constants';

export async function middleware(request: NextRequest) {
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
      if (!canAccess((level as AccessLevel | null) ?? null, request.nextUrl.pathname)) {
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
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

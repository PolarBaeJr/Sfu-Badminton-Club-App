import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Admin role cache: short-lived signed cookie. We cache (user_id + isAdmin)
// for 15 minutes to avoid one Supabase RPC roundtrip per protected request.
// Cache busts whenever the user_id changes (re-login) or the cookie expires.
const ADMIN_ROLE_COOKIE = 'sfu_admin_role';
const ADMIN_ROLE_TTL_SECONDS = 15 * 60;

function readRoleCookie(value: string | undefined, currentUserId: string): boolean | null {
  if (!value) return null;
  try {
    const [storedUserId, storedFlag] = value.split('|');
    if (storedUserId !== currentUserId) return null; // user changed; invalidate
    if (storedFlag === 'admin') return true;
    if (storedFlag === 'denied') return false;
    return null;
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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

  const isPublicRoute =
    request.nextUrl.pathname.startsWith('/login') ||
    request.nextUrl.pathname.startsWith('/auth') ||
    request.nextUrl.pathname === '/unauthorized';

  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  if (user && !isPublicRoute) {
    // Cache hit: trust the signed cookie if user_id matches.
    const cached = readRoleCookie(request.cookies.get(ADMIN_ROLE_COOKIE)?.value, user.id);
    let isAdmin: boolean;

    if (cached !== null) {
      isAdmin = cached;
    } else {
      // Cache miss: hit the RPC, then write the result back to a 15-min cookie.
      const { data } = await supabase.rpc('is_admin', { p_user_id: user.id });
      isAdmin = !!data;
      supabaseResponse.cookies.set(ADMIN_ROLE_COOKIE, `${user.id}|${isAdmin ? 'admin' : 'denied'}`, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: ADMIN_ROLE_TTL_SECONDS,
        path: '/',
      });
    }

    if (!isAdmin) {
      const url = request.nextUrl.clone();
      url.pathname = '/unauthorized';
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|_next/data|favicon.ico|robots.txt|sitemap.xml|manifest.json|sw.js|monitoring|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf)$).*)',
  ],
};

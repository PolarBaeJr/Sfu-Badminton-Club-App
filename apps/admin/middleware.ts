import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Legacy admin-role cache cookie. It was plaintext "<uid>|admin" and acted as
// a forgeable trust boundary (2026-06-09 audit C2) — any authenticated player
// could send a crafted value and skip the is_admin check. The cache is gone:
// every protected request now re-verifies role + account standing against the
// database (cheap at this club's traffic — one RPC + one own-row select).
// The constant remains only so lingering cookies get expired off clients.
const LEGACY_ADMIN_ROLE_COOKIE = 'sfu_admin_role';

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
    // Re-verify on every request: role via the SECURITY DEFINER RPC, account
    // standing via the caller's own row (status/deleted_at are in the
    // column-safe grant from 00032). No cache — a demoted, suspended, or
    // deleted admin loses access on their next request.
    const [{ data: roleOk }, { data: standing }] = await Promise.all([
      supabase.rpc('is_admin', { p_user_id: user.id }),
      supabase
        .from('players')
        .select('status, deleted_at')
        .eq('user_id', user.id)
        .single(),
    ]);

    const isAdmin =
      !!roleOk &&
      !!standing &&
      standing.status !== 'suspended' &&
      standing.deleted_at === null;

    if (!isAdmin) {
      const url = request.nextUrl.clone();
      url.pathname = '/unauthorized';
      return NextResponse.redirect(url);
    }
  }

  // Expire the legacy role-cache cookie wherever it still exists.
  if (request.cookies.get(LEGACY_ADMIN_ROLE_COOKIE)) {
    supabaseResponse.cookies.set(LEGACY_ADMIN_ROLE_COOKIE, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 0,
      path: '/',
    });
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|_next/data|favicon.ico|robots.txt|sitemap.xml|manifest.json|sw.js|monitoring|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf)$).*)',
  ],
};

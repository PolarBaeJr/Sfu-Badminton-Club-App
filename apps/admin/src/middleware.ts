import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { canAccess, type AccessLevel } from '@/lib/permissions';

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

  const isPublicRoute =
    request.nextUrl.pathname.startsWith('/login') ||
    request.nextUrl.pathname.startsWith('/auth') ||
    request.nextUrl.pathname === '/unauthorized';

  try {
    const { data: { user } } = await supabase.auth.getUser();

    if (!user && !isPublicRoute) {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }

    if (user && !isPublicRoute) {
      const { data: level } = await supabase.rpc('admin_access_level', { p_user_id: user.id });
      if (!canAccess((level as AccessLevel | null) ?? null, request.nextUrl.pathname)) {
        const url = request.nextUrl.clone();
        url.pathname = '/unauthorized';
        return NextResponse.redirect(url);
      }
    }
  } catch {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

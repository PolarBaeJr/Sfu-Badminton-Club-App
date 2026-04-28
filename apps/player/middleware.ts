import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  // Strip any client-supplied x-user-id; this header is only ever set by us
  // after auth resolution so downstream RSCs can skip a redundant auth.getUser().
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete('x-user-id');

  const cookiesToWrite: { name: string; value: string; options?: Record<string, unknown> }[] = [];

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
          cookiesToWrite.push(...cookiesToSet);
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  if (
    !user &&
    !request.nextUrl.pathname.startsWith('/login') &&
    !request.nextUrl.pathname.startsWith('/auth')
  ) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    const redirect = NextResponse.redirect(url);
    cookiesToWrite.forEach(({ name, value, options }) =>
      redirect.cookies.set(name, value, options as any)
    );
    return redirect;
  }

  if (user) requestHeaders.set('x-user-id', user.id);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  cookiesToWrite.forEach(({ name, value, options }) =>
    response.cookies.set(name, value, options as any)
  );
  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|_next/data|favicon.ico|robots.txt|sitemap.xml|manifest.json|sw.js|monitoring|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf)$).*)',
  ],
};

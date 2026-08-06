import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { rateLimit, getClientIp } from '@badminton/shared';
import { AUTH_COOKIE_DOMAIN, AUTH_COOKIE_OPTIONS, hostOnlyAuthCookieClears } from '@badminton/shared';
import { adminBaseUrl } from '@/lib/base-path';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // Base URL of THIS console, prefix included — on the path-mounted build
  // that is https://sfubadminton.com/admin, and every redirect below has to
  // carry the /admin or it lands on the player app (a different container).
  const origin = adminBaseUrl(new URL(request.url).origin);
  const code = searchParams.get('code');
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type');

  // Rate limit: 10 callback attempts per IP per minute (defense against brute force)
  const ip = getClientIp(request);
  const rl = rateLimit(`auth-cb:${ip}`, 10, 60_000);
  if (!rl.success) {
    return new NextResponse('Too many requests', { status: 429 });
  }

  const cookieStore = await cookies();

  // Create the redirect response upfront so cookies are set directly on it
  const response = NextResponse.redirect(`${origin}/dashboard`);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options as any);
          });
          // Expire the old host-only cookie in the same response that mints the
          // domain-scoped one, so the two never coexist. Raw append because
          // ResponseCookies is keyed by name and would clobber the write above.
          hostOnlyAuthCookieClears(cookiesToSet).forEach((c) =>
            response.headers.append('set-cookie', c)
          );
        },
      },
    }
  );

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(`${origin}/login`);
    }
  } else if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash, type: type as 'magiclink' | 'email' });
    if (error) {
      return NextResponse.redirect(`${origin}/login`);
    }
  } else {
    return NextResponse.redirect(`${origin}/login`);
  }

  // Check if user has admin or exec access
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    const { data: level } = await supabase.rpc('admin_access_level', { p_user_id: user.id });
    if (!level) {
      // Show them the door WITHOUT ending their session.
      //
      // This used to sign the user out, and only skipped that when the auth
      // cookie was domain-scoped. That var is unset, so the destructive path is
      // the one that actually runs: an ordinary member who wandered onto the
      // admin login was signed out of the PLAYER app too — silently, with no
      // hint that visiting the wrong URL had done it.
      //
      // Signing them out buys nothing. The middleware already blocks every
      // non-public admin route on admin_access_level, so a session with no
      // access level cannot reach anything here. /unauthorized offers an
      // explicit Sign out button for anyone who genuinely wants to end it.
      return NextResponse.redirect(`${origin}/unauthorized`);
    }
  }

  return response;
}

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
      // Build the unauthorized redirect *first* so the signOut clear-cookie headers
      // land on the response that actually goes to the browser.
      const unauthorized = NextResponse.redirect(`${origin}/unauthorized`);

      // With a subdomain-shared cookie this signOut is no longer local to the
      // console — it would destroy the player-app session of any member who
      // simply tried to sign in on the wrong host, silently and everywhere. The
      // session is legitimately shared now, and the middleware still blocks
      // every non-public admin route on admin_access_level, so leaving it
      // intact costs nothing. /unauthorized offers an explicit Sign out button
      // for anyone who does want to end the session.
      if (AUTH_COOKIE_DOMAIN) return unauthorized;

      const signoutSupabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          // Must match the client that set the cookie, or signOut clears nothing.
          cookieOptions: AUTH_COOKIE_OPTIONS,
          cookies: {
            getAll() { return cookieStore.getAll(); },
            setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
              // No companion host-only clear: the guard above means this branch
              // only ever runs with AUTH_COOKIE_DOMAIN unset, where the cookie
              // is host-only and this signOut already clears it.
              cookiesToSet.forEach(({ name, value, options }) => {
                unauthorized.cookies.set(name, value, options as any);
              });
            },
          },
        }
      );
      await signoutSupabase.auth.signOut();
      return unauthorized;
    }
  }

  return response;
}

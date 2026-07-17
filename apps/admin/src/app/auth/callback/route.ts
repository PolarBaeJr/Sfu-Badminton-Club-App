import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { rateLimit, getClientIp } from '@badminton/shared';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const origin = process.env.NEXT_PUBLIC_ADMIN_URL || new URL(request.url).origin;
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
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options as any);
          });
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
      const signoutSupabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          cookies: {
            getAll() { return cookieStore.getAll(); },
            setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
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

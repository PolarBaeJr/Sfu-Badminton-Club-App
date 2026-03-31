import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type');

  // Create the redirect response upfront so cookies are set directly on it
  const redirectTo = `${origin}/dashboard`;
  const response = NextResponse.redirect(redirectTo);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.headers.get('cookie')?.split(';').map(c => {
            const [name, ...rest] = c.trim().split('=');
            return { name, value: decodeURIComponent(rest.join('=')) };
          }).filter(c => c.name) || [];
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
    await supabase.auth.exchangeCodeForSession(code);
  } else if (token_hash && type) {
    await supabase.auth.verifyOtp({ token_hash, type: type as 'magiclink' | 'email' });
  }

  return response;
}

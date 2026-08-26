import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { CHECKIN_TOKEN_REGEX, DISCORD_LINK_TOKEN_REGEX } from '@badminton/shared';
import { AUTH_COOKIE_OPTIONS, hostOnlyAuthCookieClears } from '@badminton/shared';
import { reactivateLapsedMemberByUserId } from '@/lib/reactivate';
import { ensurePlayerRowForUser } from '@/lib/first-signin';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
  const code = searchParams.get('code');
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type');

  const cookieStore = await cookies();

  // A session QR scanned while logged out round-trips its token through here.
  // Only a well-formed 48-hex token is honoured and it can only ever build the
  // /checkin/<token> path, so this can't be turned into an open redirect.
  const checkin = searchParams.get('checkin');
  // Same for the Discord /link button. Re-validated HERE rather than trusted
  // from the previous hop: every step of this chain checks the shape again, so
  // no single missed check turns the chain into an open redirect.
  const discord = searchParams.get('discord');
  const destination = checkin && CHECKIN_TOKEN_REGEX.test(checkin)
    ? `${origin}/checkin/${checkin}`
    : discord && DISCORD_LINK_TOKEN_REGEX.test(discord)
      ? `${origin}/link/${discord}`
      : `${origin}/`;

  // Create redirect response upfront so session cookies are set on it
  const response = NextResponse.redirect(destination);

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

  let userId: string | null = null;

  if (code) {
    // OAuth or PKCE magic link flow
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(`${origin}/login?error=auth_failed`);
    }
    userId = data.user?.id ?? null;
  } else if (token_hash && type) {
    // Non-PKCE magic link flow
    const { data, error } = await supabase.auth.verifyOtp({ token_hash, type: type as 'magiclink' | 'email' });
    if (error) {
      return NextResponse.redirect(`${origin}/login?error=auth_failed`);
    }
    userId = data.user?.id ?? null;
  } else {
    return NextResponse.redirect(`${origin}/login`);
  }

  // This route redirects to `/`, not to /auth/post-login, so it is its own
  // sign-in entry point and needs its own reactivation. The user id comes off
  // the exchange result rather than getCurrentPlayer(): the session cookie is
  // being SET on this response, so next/headers cannot see it yet on this
  // request. Best-effort — the requirePlayer() net catches anything missed
  // here, and a failed lookup must not cost the member their sign-in.
  // BEFORE reactivation, and the order matters: reactivateLapsedMemberByUserId
  // looks the member up BY user_id, so on a first sign-in there is nothing for
  // it to find until this has run. Both are best-effort and neither throws.
  if (userId) {
    await ensurePlayerRowForUser(userId);
    await reactivateLapsedMemberByUserId(userId);
  }

  return response;
}

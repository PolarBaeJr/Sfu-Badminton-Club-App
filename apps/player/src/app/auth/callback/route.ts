import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { CHECKIN_TOKEN_REGEX, DISCORD_LINK_TOKEN_REGEX } from '@badminton/shared';
import { AUTH_COOKIE_OPTIONS, hostOnlyAuthCookieClears } from '@badminton/shared';
import { getServerSupabaseUrl } from '@badminton/shared';
import { reactivateLapsedMemberByUserId } from '@/lib/reactivate';
import { ensurePlayerRowForUser } from '@/lib/first-signin';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  LOGIN_INTENT_COOKIE,
  isSigninIntent,
  signupRejectPath,
  type AuthTokenParam,
} from '@/lib/auth-intent';

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

  const tokenParam: AuthTokenParam | null = checkin && CHECKIN_TOKEN_REGEX.test(checkin)
    ? { key: 'checkin', token: checkin }
    : discord && DISCORD_LINK_TOKEN_REGEX.test(discord)
      ? { key: 'discord', token: discord }
      : null;

  // Session cookie writes are BUFFERED, not set on a response up front: a
  // Google sign-in that finds no account must leave with none of them, and
  // only once the exchange has run do we know which response we are sending.
  const writes: { name: string; value: string; options?: Record<string, unknown> }[] = [];
  const rawClears: string[] = [];
  const apply = (res: NextResponse) => {
    writes.forEach(({ name, value, options }) => res.cookies.set(name, value, options as any));
    rawClears.forEach((c) => res.headers.append('set-cookie', c));
    return res;
  };

  // Set by /login's Google button. Cleared on EVERY response from here, so it
  // can never outlive the one round trip it was set for.
  const signinOnly = isSigninIntent(cookieStore.get(LOGIN_INTENT_COOKIE)?.value);
  const clearIntent = (res: NextResponse) => {
    res.cookies.set(LOGIN_INTENT_COOKIE, '', { path: '/auth', maxAge: 0 });
    return res;
  };

  const supabase = createServerClient(
    getServerSupabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          writes.push(...cookiesToSet);
          // Expire the old host-only cookie in the same response that mints the
          // domain-scoped one, so the two never coexist. Raw append because
          // ResponseCookies is keyed by name and would clobber the write above.
          rawClears.push(...hostOnlyAuthCookieClears(cookiesToSet));
        },
      },
    }
  );

  let userId: string | null = null;

  if (code) {
    // OAuth or PKCE magic link flow
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return clearIntent(NextResponse.redirect(`${origin}/login?error=auth_failed`));
    }
    userId = data.user?.id ?? null;

    // A Google SIGN-IN (the intent cookie) for an account with no player row
    // is not allowed to enroll anyone: sign it back out and send it to
    // /signup. This MUST run before ensurePlayerRowForUser below, which gives
    // every signed-in user a row and would make the check find one every time.
    // The auth.users row GoTrue just created is left alone; /signup continues
    // with the same user. Only this branch: the token_hash branch is the magic
    // link path, and the player's code-only template never sends one.
    if (userId && signinOnly) {
      const { data: row, error: rowError } = await createServiceRoleClient()
        .from('players')
        .select('id')
        .eq('user_id', userId)
        .maybeSingle();
      if (!rowError && !row) {
        // Revokes this session's refresh token. The cookie removals it writes
        // land in `writes`, which the reject response never applies, so no
        // session cookie is set either.
        await supabase.auth.signOut({ scope: 'local' });
        return clearIntent(NextResponse.redirect(`${origin}${signupRejectPath(tokenParam)}`));
      }
      // On a lookup error, fail OPEN and continue, the same stance as the
      // middleware's onboarding gate and first-signin.ts.
    }
  } else if (token_hash && type) {
    // Non-PKCE magic link flow
    const { data, error } = await supabase.auth.verifyOtp({ token_hash, type: type as 'magiclink' | 'email' });
    if (error) {
      return clearIntent(NextResponse.redirect(`${origin}/login?error=auth_failed`));
    }
    userId = data.user?.id ?? null;
  } else {
    return clearIntent(NextResponse.redirect(`${origin}/login`));
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

  // apply() LAST: any cookies.set after a raw set-cookie append rebuilds the
  // header from its own map and silently drops the host-only clears.
  return apply(clearIntent(NextResponse.redirect(destination)));
}

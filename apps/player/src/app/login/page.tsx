'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import { CHECKIN_TOKEN_REGEX, DISCORD_LINK_TOKEN_REGEX, friendlyAuthError } from '@badminton/shared';
import { Mail, CheckCircle2, ChevronRight, Loader2, KeyRound } from 'lucide-react';
import { ShuttleMark } from '@/components/shuttle-mark';
import {
  signInWithPasskey,
  supportsPasskeys,
  beginConditionalPasskeySignIn,
  cancelPasskeyCeremony,
  PASSKEY_AUTOFILL_AUTOCOMPLETE,
} from '@/lib/passkey-client';

// A player who scans a session QR while logged out arrives at
// /login?checkin=<token>; carry that token through sign-in so they land back on
// /checkin/<token> instead of silently losing it. Deliberately a single-purpose
// token rather than a `next=` path — an arbitrary redirect target is an
// open-redirect waiting to happen, a 48-hex token can only ever be one route.
// Read from window.location instead of useSearchParams(): in the Next 14 App
// Router the hook fails the production build unless the whole page is wrapped
// in <Suspense>.
//
// The Discord bot's /link button is the second case with exactly this shape,
// so ONE function returns whichever suffix applies. Five call sites below hand
// off to two different destinations (/auth/callback for Google and emailed
// codes, /auth/post-login for everything else) and missing any one of them
// would break exactly one sign-in method — silently, and only for members who
// happen to use that method.
function authSuffix(): string {
  const params = new URLSearchParams(window.location.search);

  const checkin = params.get('checkin') ?? '';
  if (CHECKIN_TOKEN_REGEX.test(checkin)) return `?checkin=${checkin}`;

  const discord = params.get('discord') ?? '';
  if (DISCORD_LINK_TOKEN_REGEX.test(discord)) return `?discord=${discord}`;

  return '';
}

export default function LoginPage() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [seasonName, setSeasonName] = useState('');
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  // Resolved in an effect, never during render: browserSupportsWebAuthn()
  // touches window, so deciding this inline would mismatch the server HTML.
  const [canUsePasskeys, setCanUsePasskeys] = useState(false);

  useEffect(() => {
    setCanUsePasskeys(supportsPasskeys());
  }, []);

  // Passkey autofill. The member presses nothing: if this browser supports
  // conditional mediation and they have a credential for this site, it appears
  // in the email field's own dropdown and picking it signs them in.
  //
  // Deliberately NOT gated on canUsePasskeys — beginConditionalPasskeySignIn
  // does its own (stricter) detection and returns false without touching the
  // network when the browser cannot do this, so gating here would only add a
  // render's delay and a second source of truth.
  //
  // Runs only on the screen that actually has the email field: the code screen
  // (`sent`) has unmounted it, and under "Sign up" a passkey cannot help — it
  // proves an account that already exists. Leaving either of those states runs
  // the cleanup, which cancels the pending ceremony so it can never complete
  // against a challenge cookie some later request has replaced.
  useEffect(() => {
    if (sent || mode !== 'signin') return;
    let live = true;
    void beginConditionalPasskeySignIn().then((signedIn) => {
      if (signedIn && live) window.location.href = `/auth/post-login${authSuffix()}`;
    });
    return () => {
      live = false;
      cancelPasskeyCeremony();
    };
  }, [sent, mode]);

  async function handlePasskeyLogin() {
    setPasskeyLoading(true);
    setError('');
    const result = await signInWithPasskey();
    if (result.ok) {
      window.location.href = `/auth/post-login${authSuffix()}`;
      return;
    }
    // An empty message means the user dismissed the system prompt — that is a
    // deliberate action, not a failure to report back at them.
    if (result.error) setError(result.error);
    setPasskeyLoading(false);
  }

  // The login page is logged-out, so it can't read the seasons table under RLS.
  // The anon-safe get_active_season() RPC surfaces just the season name.
  useEffect(() => {
    (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase.rpc('get_active_season');
        setSeasonName(data?.[0]?.name ?? '');
      } catch {
        // No active season / offline — fall back to no suffix.
      }
    })();
  }, []);

  async function handleGoogleLogin() {
    setGoogleLoading(true);
    setError('');
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback${authSuffix()}` },
    });
    if (authError) {
      setError(friendlyAuthError(authError.message));
      setGoogleLoading(false);
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const supabase = createClient();
    const send = () =>
      supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback${authSuffix()}` },
      });
    // The auth gateway can 503 on the first request after an idle period; a
    // single silent retry makes that invisible to the user instead of showing
    // a scary error they'd just have to click through themselves.
    let { error: authError } = await send();
    if (authError) {
      await new Promise((r) => setTimeout(r, 900));
      ({ error: authError } = await send());
    }
    if (authError) {
      setError(friendlyAuthError(authError.message));
    } else {
      setSent(true);
    }
    setLoading(false);
  }

  // Verify the 6-digit code from the email. Codes (unlike links) survive
  // corporate email link-scanners (e.g. SFU/Microsoft Safe Links) that would
  // otherwise pre-fetch and consume a one-time magic-link before the user clicks.
  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const supabase = createClient();
    const token = code.trim();
    // GoTrue issues a different OTP token type per flow (verified against the
    // live DB): an existing account gets a `recovery` token, a brand-new signup
    // a `signup` (confirmation) token. The old `type: 'email'` matched neither
    // and always failed with "Invalid email verification type". The client
    // can't be certain which flow a user is in (they may pick the wrong tab),
    // so try the mode-appropriate type first and fall back to the other. A
    // wrong-type attempt looks up a different token column and returns
    // "not found" without consuming the real token, so the fallback is safe.
    const typeOrder = mode === 'signup'
      ? (['signup', 'recovery'] as const)
      : (['recovery', 'signup'] as const);

    let authError: { message: string } | null = null;
    for (const type of typeOrder) {
      const { error } = await supabase.auth.verifyOtp({ email, token, type });
      if (!error) {
        window.location.href = `/auth/post-login${authSuffix()}`;
        return;
      }
      authError = error;
      // Only fall through to the other type on a type/token mismatch; a genuinely
      // wrong or expired code should surface immediately.
      if (!/verification type|not found/i.test(authError.message ?? '')) break;
    }
    setError(friendlyAuthError(authError?.message ?? 'That code didn’t work — request a new one.'));
    setLoading(false);
  }

  return (
    // A login screen is a utility, not a landing page: no full-height brand
    // panel, nothing to scroll past. One centred card, form immediately
    // reachable at any viewport size.
    <div
      className="auth"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg)',
        padding: '40px 20px',
      }}
    >
      <div
        className="auth-card"
        style={{
          width: '100%',
          maxWidth: 380,
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
        }}
      >
        {/* Brand is a signature, not a billboard — enough to confirm you are in
            the right place, then out of the way. */}
        <div className="row" style={{ gap: 10, justifyContent: 'center' }}>
          <div className="brand-mark" style={{ width: 30, height: 30 }}><ShuttleMark /></div>
          <div style={{ lineHeight: 1.15 }}>
            <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 17, letterSpacing: '-.01em' }}>
              SFU Badminton
            </div>
            {seasonName && (
              <div className="mono muted" style={{ fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase' }}>
                {seasonName}
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="page-eyebrow"><span className="bar" /> {mode === 'signin' ? 'WELCOME BACK' : 'NEW PLAYER'}</div>
          <h2
            style={{
              fontFamily: 'var(--display)',
              fontSize: 36,
              fontWeight: 700,
              letterSpacing: '-.03em',
              margin: '8px 0 0',
            }}
          >
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </h2>
          <div className="page-sub" style={{ marginTop: 8 }}>
            {mode === 'signin'
              ? 'We\'ll email you a 6-digit sign-in code. No password to remember.'
              : 'Join the club roster. We\'ll email you a 6-digit code to get you in.'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 999, border: '1px solid var(--line)', background: 'var(--surface-2)' }}>
          {(['signin', 'signup'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setError(''); setSent(false); }}
              className={'btn btn-sm' + (mode === m ? ' btn-dark' : ' btn-ghost')}
              style={{ flex: 1, justifyContent: 'center', borderColor: 'transparent' }}
            >
              {m === 'signin' ? 'Sign in' : 'Sign up'}
            </button>
          ))}
        </div>

        {sent ? (
          <div className="card-base" style={{ padding: 28 }}>
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: 56,
                  height: 56,
                  margin: '0 auto 14px',
                  borderRadius: 999,
                  background: 'var(--red-wash)',
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                <CheckCircle2 size={28} style={{ color: 'var(--red)' }} />
              </div>
              <div style={{ fontFamily: 'var(--display)', fontSize: 22, fontWeight: 700 }}>Enter your code</div>
              <div className="page-sub" style={{ marginTop: 8 }}>
                We emailed a 6-digit code to <strong>{email}</strong>. Enter it below.
              </div>
            </div>
            <form onSubmit={handleVerifyCode} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 18 }}>
              <input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                autoFocus
                className="input-base"
                style={{
                  fontSize: 22,
                  letterSpacing: '.4em',
                  textAlign: 'center',
                  fontFamily: 'var(--mono)',
                }}
              />
              {error && <div className="alert-danger">{error}</div>}
              <button type="submit" disabled={loading || code.length < 6} className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center', height: 48 }}>
                {loading ? <Loader2 size={16} className="animate-spin" /> : null}
                Sign in
              </button>
            </form>
            <button
              type="button"
              onClick={() => { setSent(false); setCode(''); setError(''); }}
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 12, width: '100%', justifyContent: 'center' }}
            >
              Use a different email
            </button>
          </div>
        ) : (
          <>
            {/* Sign-in only. A passkey proves you are an account that already
                exists, so offering it under "Sign up" invites people to try
                the one route that cannot possibly work for them. Google stays
                in both modes because it can genuinely create an account. */}
            {canUsePasskeys && mode === 'signin' && (
              <button
                type="button"
                onClick={handlePasskeyLogin}
                disabled={passkeyLoading}
                className="btn btn-ghost btn-lg"
                style={{ width: '100%', justifyContent: 'center', height: 48, gap: 10, marginBottom: 10 }}
              >
                {passkeyLoading ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <KeyRound size={18} />
                )}
                Sign in with a passkey
              </button>
            )}

            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={googleLoading}
              className="btn btn-ghost btn-lg"
              style={{ width: '100%', justifyContent: 'center', height: 48, gap: 10 }}
            >
              {googleLoading ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
              )}
              Continue with Google
            </button>

            <div className="hr-label">or with email</div>

            <form onSubmit={handleMagicLink} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label htmlFor="email" className="mono muted" style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' }}>
                Email
              </label>
              <div style={{ position: 'relative' }}>
                <Mail
                  size={16}
                  className="text-[var(--mute)]"
                  style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}
                />
                {/* The `webauthn` token is what makes this field an autofill
                    surface for a passkey — without it the conditional request
                    above refuses to start. See PASSKEY_AUTOFILL_AUTOCOMPLETE. */}
                <input
                  id="email"
                  type="email"
                  autoComplete={PASSKEY_AUTOFILL_AUTOCOMPLETE}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@sfu.ca"
                  required
                  className="input-base"
                  style={{ paddingLeft: 38 }}
                />
              </div>
              {error && <div className="alert-danger">{error}</div>}
              <button
                type="submit"
                disabled={loading}
                className="btn btn-primary btn-lg"
                style={{ width: '100%', justifyContent: 'center', height: 48 }}
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Mail size={14} />}
                Email me a code
                {!loading && <ChevronRight size={14} />}
              </button>
            </form>
          </>
        )}

        <div className="muted" style={{ fontSize: 12, textAlign: 'center' }}>
          By signing in you agree to the{' '}
          <Link href="/legal/terms" style={{ color: 'inherit', textDecoration: 'underline' }}>Terms of Use</Link>
          {' '}and{' '}
          <Link href="/legal/privacy" style={{ color: 'inherit', textDecoration: 'underline' }}>Privacy Policy</Link>.
        </div>
      </div>
    </div>
  );
}

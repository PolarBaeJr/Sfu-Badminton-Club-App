'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { Button, Input, Card } from '@badminton/ui';
import { friendlyAuthError } from '@badminton/shared';
import { Shield, Mail, Loader2, Globe, AlertCircle, KeyRound } from 'lucide-react';
import {
  signInWithPasskey,
  supportsPasskeys,
  beginConditionalPasskeySignIn,
  cancelPasskeyCeremony,
  PASSKEY_AUTOFILL_AUTOCOMPLETE,
} from '@/lib/passkey-client';
import { SIGNIN_OTP_TYPES, shouldTryNextOtpType, isUnknownAccountError } from '@/lib/auth-otp';
import { withBase } from '@/lib/base-path';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  // Resolved in an effect, never during render: browserSupportsWebAuthn()
  // touches window, so deciding this inline would mismatch the server HTML.
  const [canUsePasskeys, setCanUsePasskeys] = useState(false);
  // The player and admin apps share one auth cookie on this domain. If an admin
  // is already signed in (e.g. via the player app), forward them straight in
  // instead of making them sign in a second time.
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth
      .getSession()
      .then(async ({ data: { session } }) => {
        if (session) {
          const { data: isAdmin } = await supabase.rpc('is_admin', { p_user_id: session.user.id });
          if (isAdmin) {
            router.replace('/dashboard');
            return;
          }
        }
        setCheckingSession(false);
      })
      .catch(() => setCheckingSession(false));
  }, [router]);

  useEffect(() => {
    setCanUsePasskeys(supportsPasskeys());
  }, []);

  // Passkey autofill — the admin's credential appears in the email field's own
  // dropdown, no button pressed. Held until the session check has finished:
  // an admin who is already signed in is about to be redirected to /dashboard,
  // and the form (with its email field) has not rendered yet, so starting here
  // would only throw the "no <input> with webauthn" error into the void.
  // Skipped once a code has been requested — that screen has no email field.
  useEffect(() => {
    if (checkingSession || sent) return;
    let live = true;
    void beginConditionalPasskeySignIn().then((signedIn) => {
      if (signedIn && live) window.location.href = withBase('/dashboard');
    });
    return () => {
      live = false;
      cancelPasskeyCeremony();
    };
  }, [checkingSession, sent]);

  async function handlePasskeyLogin() {
    setPasskeyLoading(true);
    setError('');
    const result = await signInWithPasskey();
    if (result.ok) {
      // A full navigation, not router.replace(): the session cookie arrived on a
      // fetch() response, so the in-memory Supabase browser client still thinks
      // it is logged out. Reloading rebuilds it from the cookie.
      window.location.href = withBase('/dashboard');
      return;
    }
    // An empty message means the user dismissed the system prompt — that is a
    // deliberate action, not a failure to report back at them.
    if (result.error) setError(result.error);
    setPasskeyLoading(false);
  }

  async function handleGoogleLogin() {
    setGoogleLoading(true);
    setError('');
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}${withBase('/auth/callback')}` },
    });
    if (authError) {
      setError(authError.message);
      setGoogleLoading(false);
    }
  }

  // Email the 6-digit code. No emailRedirectTo: the template is code-only, so
  // the message renders no link and nothing on this path ever reaches
  // /auth/callback — that route stays for Google's PKCE exchange.
  async function sendCode() {
    setLoading(true);
    setError('');
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOtp({
      email,
      // The console is sign-in only, and must not become a signup form by
      // accident: left to its default, signInWithOtp mints an account for
      // whatever address is typed here. Someone who cannot get in is a far
      // smaller problem than an admin login that silently creates accounts.
      options: { shouldCreateUser: false },
    });
    if (authError) {
      setError(
        isUnknownAccountError(authError.message)
          ? 'No account uses that email. The console cannot create one — sign up in the player app first, then ask an admin for access.'
          : friendlyAuthError(authError.message)
      );
    } else {
      setCode('');
      setSent(true);
    }
    setLoading(false);
  }

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    await sendCode();
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const supabase = createClient();
    const token = code.trim();
    let authError: { message: string } | null = null;
    // See lib/auth-otp for why this is a list and not a single type.
    for (const type of SIGNIN_OTP_TYPES) {
      const { error: verifyError } = await supabase.auth.verifyOtp({ email, token, type });
      if (!verifyError) {
        // withBase, and a full navigation: an unprefixed /dashboard is not a
        // 404 here, it is a live route on the PLAYER app.
        window.location.href = withBase('/dashboard');
        return;
      }
      authError = verifyError;
      if (!shouldTryNextOtpType(verifyError.message)) break;
    }
    setError(friendlyAuthError(authError?.message ?? 'That code didn’t work — request a new one.'));
    setLoading(false);
  }

  if (checkingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-card)' }}>
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--color-accent)' }} />
      </div>
    );
  }

  // Both steps of the email flow can fail, and a bad code is the likelier of
  // the two — one banner, rendered wherever the error was raised.
  const errorBanner = error ? (
    <div
      className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm"
      style={{
        background: 'rgba(239,68,68,0.08)',
        border: '1px solid rgba(239,68,68,0.2)',
        color: '#EF4444',
      }}
    >
      <AlertCircle className="w-4 h-4 flex-shrink-0" />
      <span>{error}</span>
    </div>
  ) : null;

  return (
    <div
      className="min-h-screen flex items-center justify-center relative overflow-hidden"
      style={{
        background: 'radial-gradient(ellipse at top, rgba(233,69,96,0.08) 0%, transparent 50%), radial-gradient(ellipse at bottom right, rgba(15,52,96,0.3) 0%, transparent 50%), var(--bg-card)',
      }}
    >
      {/* Subtle grid pattern overlay */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />

      <div className="relative z-10 w-full max-w-md px-4">
        {/* Glow effect behind card */}
        <div
          className="absolute -inset-4 rounded-3xl opacity-20 blur-2xl"
          style={{ background: 'linear-gradient(135deg, var(--color-accent), transparent 60%)' }}
        />

        <div
          className="relative w-full overflow-hidden rounded-xl bg-[var(--bg-card)] p-6"
          style={{
            border: '1px solid rgba(233,69,96,0.15)',
            boxShadow: '0 0 40px rgba(233,69,96,0.06), 0 8px 32px rgba(0,0,0,0.3)',
          }}
        >
          {/* Header */}
          <div className="text-center mb-8 pt-2">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-5" style={{ background: 'rgba(233,69,96,0.12)', border: '1px solid rgba(233,69,96,0.2)' }}>
              <Shield className="w-7 h-7" style={{ color: 'var(--color-accent)' }} />
            </div>
            <h1
              className="text-3xl font-bold font-display tracking-[0.2em] mb-1"
              style={{ color: 'var(--color-accent)' }}
            >
              SFU BADMINTON
            </h1>
            <p className="text-sm font-medium tracking-wider uppercase" style={{ color: 'var(--text-muted)' }}>
              Admin Portal
            </p>
          </div>

          {sent ? (
            <div className="space-y-5">
              <div className="text-center">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full mb-4" style={{ background: 'rgba(233,69,96,0.12)', border: '1px solid rgba(233,69,96,0.2)' }}>
                  <Mail className="w-8 h-8" style={{ color: 'var(--color-accent)' }} />
                </div>
                <p className="font-semibold text-lg mb-1" style={{ color: 'var(--text-primary)' }}>
                  Enter your code
                </p>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  We emailed a 6-digit code to{' '}
                  <strong style={{ color: 'var(--text-primary)' }}>{email}</strong>
                </p>
              </div>

              <form onSubmit={handleVerifyCode} className="space-y-4">
                <Input
                  label="Sign-in code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  autoFocus
                  required
                  className="text-center text-xl font-mono tracking-[0.4em]"
                />

                {errorBanner}

                <button
                  type="submit"
                  disabled={loading || code.length < 6}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-semibold text-sm transition-all duration-200 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                  style={{
                    background: 'var(--color-accent)',
                    color: '#ffffff',
                    boxShadow: '0 4px 16px rgba(233,69,96,0.25)',
                  }}
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
                  Sign In
                </button>
              </form>

              <div className="flex items-center justify-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                <button
                  type="button"
                  onClick={sendCode}
                  disabled={loading}
                  className="underline underline-offset-4 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Send a new code
                </button>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={() => {
                    setSent(false);
                    setCode('');
                    setError('');
                  }}
                  className="underline underline-offset-4 cursor-pointer"
                >
                  Use a different email
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Passkey sign-in. Listed first: for an exec who has enrolled one
                  it is the fastest way in and the only one that needs neither an
                  inbox nor a third party. Hidden entirely where WebAuthn is
                  unavailable rather than shown broken. */}
              {canUsePasskeys && (
                <button
                  onClick={handlePasskeyLogin}
                  disabled={passkeyLoading}
                  className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl font-medium text-sm transition-all duration-200 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'rgba(233,69,96,0.4)';
                    e.currentTarget.style.boxShadow = '0 0 16px rgba(233,69,96,0.08)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'var(--border)';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  {passkeyLoading ? (
                    <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-muted)' }} />
                  ) : (
                    <KeyRound className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
                  )}
                  Sign in with a passkey
                </button>
              )}

              {/* Google Login Button */}
              <button
                onClick={handleGoogleLogin}
                disabled={googleLoading}
                className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl font-medium text-sm transition-all duration-200 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'rgba(233,69,96,0.4)';
                  e.currentTarget.style.boxShadow = '0 0 16px rgba(233,69,96,0.08)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                {googleLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-muted)' }} />
                ) : (
                  <Globe className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
                )}
                Continue with Google
              </button>

              {/* OR Divider */}
              <div className="relative flex items-center gap-4">
                <div className="flex-1 h-px" style={{ background: 'linear-gradient(to right, transparent, var(--border))' }} />
                <span
                  className="text-xs font-medium uppercase tracking-widest"
                  style={{ color: 'var(--text-muted)' }}
                >
                  or
                </span>
                <div className="flex-1 h-px" style={{ background: 'linear-gradient(to left, transparent, var(--border))' }} />
              </div>

              {/* Email code form */}
              <form onSubmit={handleSendCode} className="space-y-4">
                <div className="relative">
                  {/* The trailing `webauthn` token is what lets the browser
                      offer a passkey in this field's autofill; without it the
                      conditional request refuses to start. */}
                  <Input
                    label="Email"
                    type="email"
                    autoComplete={PASSKEY_AUTOFILL_AUTOCOMPLETE}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@sfu.ca"
                    required
                  />
                </div>

                {/* Error State */}
                {errorBanner}

                {/* Submit Button */}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-semibold text-sm transition-all duration-200 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                  style={{
                    background: 'var(--color-accent)',
                    color: '#ffffff',
                    boxShadow: '0 4px 16px rgba(233,69,96,0.25)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.boxShadow = '0 4px 24px rgba(233,69,96,0.4)';
                    e.currentTarget.style.transform = 'translateY(-1px)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.boxShadow = '0 4px 16px rgba(233,69,96,0.25)';
                    e.currentTarget.style.transform = 'translateY(0)';
                  }}
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Mail className="w-4 h-4" />
                  )}
                  Email Me a Code
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

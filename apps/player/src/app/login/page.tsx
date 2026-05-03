'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@badminton/shared/supabase-browser';
import { AuthHeader, AuthShell } from '@/components/v2/atoms-layout';
import { AuthField, CTAButton } from '@/components/v2/atoms-form';
import { ShuttleMark } from '@/components/v2/atoms-display';

type View = 'signin' | 'forgot' | 'sent' | 'reset-sent';

const IGNITION_MS = 220;

export default function LoginPage() {
  const router = useRouter();
  const [view, setView] = useState<View>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string; general?: string }>({});

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const next = params.get('next');
      if (next && next.startsWith('/')) {
        sessionStorage.setItem('qr_redirect', next);
      }
      const errParam = params.get('error');
      if (errParam === 'auth_failed') {
        setErrors({ general: 'That sign-in link expired or was already used. Try again.' });
      } else if (errParam === 'oauth') {
        setErrors({ general: 'Google sign-in was cancelled or failed. Try again.' });
      }
    } catch {
      /* no-op */
    }
  }, []);

  function nextPath(): string {
    try {
      const next = new URLSearchParams(window.location.search).get('next');
      return next && next.startsWith('/') ? next : '/feed';
    } catch {
      return '/feed';
    }
  }

  function buildCallbackUrl(extraNext?: string): string {
    try {
      const base = `${window.location.origin}/auth/callback`;
      const next = extraNext ?? new URLSearchParams(window.location.search).get('next');
      return next && next.startsWith('/') ? `${base}?next=${encodeURIComponent(next)}` : base;
    } catch {
      return `${window.location.origin}/auth/callback`;
    }
  }

  function igniteAndGo(target: string) {
    setRedirecting(true);
    window.setTimeout(() => {
      router.push(target);
      router.refresh();
    }, IGNITION_MS);
  }

  async function sendMagicLink(targetEmail: string) {
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOtp({
      email: targetEmail,
      options: { emailRedirectTo: buildCallbackUrl() },
    });
    if (authError) {
      setErrors({
        general: authError.message.toLowerCase().includes('rate')
          ? 'Too many attempts — please wait before trying again'
          : authError.message,
      });
      return false;
    }
    return true;
  }

  async function handleSignin(e: React.FormEvent) {
    e.preventDefault();
    const errs: { email?: string; password?: string } = {};
    if (!email.trim()) errs.email = 'Required';
    else if (!/.+@.+\..+/.test(email)) errs.email = 'Invalid email';
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setLoading(true);

    if (password) {
      // Password path — immediate sign-in, then ignite + redirect.
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) {
        setErrors({
          general: authError.message.toLowerCase().includes('invalid')
            ? 'Email or password incorrect'
            : authError.message,
        });
        setLoading(false);
        return;
      }
      setLoading(false);
      igniteAndGo(nextPath());
      return;
    }

    // No password — magic-link path. User finishes auth in the email link.
    const ok = await sendMagicLink(email);
    setLoading(false);
    if (ok) setView('sent');
  }

  async function handleResetRequest() {
    if (!forgotEmail.trim() || !/.+@.+\..+/.test(forgotEmail)) {
      setErrors({ email: 'Invalid email' });
      return;
    }
    setErrors({});
    setLoading(true);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.resetPasswordForEmail(forgotEmail, {
      // Send users through the same callback so cookies get set, then on to
      // the dedicated reset page.
      redirectTo: buildCallbackUrl('/auth/reset-password'),
    });
    setLoading(false);
    if (authError) {
      setErrors({
        general: authError.message.toLowerCase().includes('rate')
          ? 'Too many attempts — please wait before trying again'
          : authError.message,
      });
      return;
    }
    setView('reset-sent');
  }

  async function handleGoogleLogin() {
    setGoogleLoading(true);
    setErrors({});
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      // Provider sign-in must be enabled in Supabase dashboard:
      //   Authentication → Providers → Google → Enable + set Client ID/Secret.
      // Without that the redirect will fail with provider_not_enabled.
      options: { redirectTo: buildCallbackUrl() },
    });
    if (authError) {
      setErrors({ general: authError.message });
      setGoogleLoading(false);
    }
    // On success, Supabase navigates the browser; no local cleanup needed.
  }

  // ── Brand panel (desktop split) ────────────────────────────────────
  const brandPanel = (
    <>
      <div className="auth-split-brand">
        <div className="auth-split-mark">S</div>
        <span className="auth-split-club">SFU Badminton · Player</span>
      </div>
      <h1 className="auth-split-headline">
        <span>Track your</span>
        <span>Elo. Climb</span>
        <span>the ladder.</span>
      </h1>
      <p className="auth-split-tagline">
        Sign in to log matches, accept challenges, and watch your rank move with every game.
      </p>
      <span className="auth-split-stat-row">Season 02 · Spring 2026</span>
      <div className="auth-split-foot">© {new Date().getFullYear()} SFU Badminton Club</div>
    </>
  );

  // ── Form body — shared between mobile phone-frame and desktop split ─
  const formBody = renderFormBody({
    view,
    email,
    setEmail,
    password,
    setPassword,
    showPass,
    setShowPass,
    forgotEmail,
    setForgotEmail,
    loading,
    googleLoading,
    errors,
    setView,
    onSignin: handleSignin,
    onResetRequest: handleResetRequest,
    onGoogleLogin: handleGoogleLogin,
  });

  return (
    <div
      style={{
        opacity: redirecting ? 0 : 1,
        transition: `opacity ${IGNITION_MS}ms ease-out`,
      }}
    >
      {/* Mobile / tablet — existing phone-frame shell */}
      <div className="auth-phone-only">
        <AuthShell>{formBody}</AuthShell>
      </div>

      {/* Desktop ≥1024px — split-screen */}
      <div className="auth-split-only">
        <div className="auth-split-root">
          <div className="auth-split-left">{brandPanel}</div>
          <div className="auth-split-right">
            <div className="auth-split-form">{formBody}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Form rendering — extracted so the same JSX renders inside the mobile
// phone-frame (.auth-phone-only) and the desktop split-form column
// (.auth-split-only) without duplicating logic.
// ════════════════════════════════════════════════════════════════════
function renderFormBody(p: {
  view: View;
  email: string;
  setEmail: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  showPass: boolean;
  setShowPass: (fn: (s: boolean) => boolean) => void;
  forgotEmail: string;
  setForgotEmail: (v: string) => void;
  loading: boolean;
  googleLoading: boolean;
  errors: { email?: string; password?: string; general?: string };
  setView: (v: View) => void;
  onSignin: (e: React.FormEvent) => void;
  onResetRequest: () => void;
  onGoogleLogin: () => void;
}): ReactNode {
  if (p.view === 'signin') {
    return (
      <form
        onSubmit={p.onSignin}
        style={{ flex: 1, padding: '36px 24px 28px', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 36 }}>
          <ShuttleMark size={22} color="var(--red)" />
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '2.5px',
              textTransform: 'uppercase',
              color: 'var(--red)',
            }}
          >
            SFU Badminton
          </span>
        </div>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '2.4px',
            textTransform: 'uppercase',
            color: 'var(--red)',
          }}
        >
          Welcome back
        </div>
        <div
          style={{
            fontSize: 36,
            fontWeight: 700,
            letterSpacing: '-1.2px',
            lineHeight: 1,
            marginTop: 8,
          }}
        >
          Pick up
          <br />
          where you left.
        </div>
        <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.55, marginTop: 14, marginBottom: 32 }}>
          Sign in to log matches, accept challenges, and check your ELO.
        </div>

        <AuthField
          label="SFU Email"
          type="email"
          value={p.email}
          onChange={p.setEmail}
          placeholder="you@sfu.ca"
          error={p.errors.email}
          autoFocus
        />

        <div style={{ marginBottom: 18, position: 'relative' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: 6,
            }}
          >
            <div
              style={{
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: '1.5px',
                textTransform: 'uppercase',
                color: p.errors.password ? 'var(--red)' : 'var(--dim)',
              }}
            >
              Password
              <span
                style={{
                  marginLeft: 8,
                  fontWeight: 500,
                  letterSpacing: '0.06em',
                  textTransform: 'none',
                  color: 'var(--dim)',
                }}
              >
                — leave blank for a magic link
              </span>
            </div>
            <button
              type="button"
              onClick={() => p.setView('forgot')}
              style={{
                background: 'transparent',
                border: 0,
                color: 'var(--text)',
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.06em',
                cursor: 'pointer',
                padding: 0,
                fontFamily: 'inherit',
              }}
            >
              Forgot?
            </button>
          </div>
          <input
            type={p.showPass ? 'text' : 'password'}
            value={p.password}
            onChange={(e) => p.setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            style={{
              width: '100%',
              background: 'var(--surface1)',
              border: '1px solid ' + (p.errors.password ? 'var(--red)' : 'var(--hairline)'),
              color: 'var(--ink)',
              fontSize: 14,
              fontWeight: 500,
              padding: '13px 14px',
              paddingRight: 60,
              boxSizing: 'border-box',
            }}
          />
          <button
            type="button"
            onClick={() => p.setShowPass((s) => !s)}
            style={{
              position: 'absolute',
              right: 12,
              top: 32,
              background: 'transparent',
              border: 0,
              color: 'var(--text)',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {p.showPass ? 'Hide' : 'Show'}
          </button>
          {p.errors.password && (
            <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 6, fontWeight: 600 }}>
              ↑ {p.errors.password}
            </div>
          )}
        </div>

        <CTAButton size="lg" full disabled={p.loading} type="submit">
          {p.loading
            ? p.password
              ? 'Signing in…'
              : 'Sending magic link…'
            : p.password
            ? 'Sign In'
            : 'Email me a link'}
        </CTAButton>

        {p.errors.general && (
          <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 12, fontWeight: 600 }}>
            ↑ {p.errors.general}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '24px 0' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
          <span style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: '0.18em', fontWeight: 600 }}>
            OR
          </span>
          <div style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
        </div>

        <button
          type="button"
          onClick={p.onGoogleLogin}
          disabled={p.googleLoading}
          aria-label="Continue with Google"
          style={{
            width: '100%',
            background: '#F2F2F2',
            color: 'var(--bg)',
            border: '1px solid var(--hairline)',
            padding: '13px',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '0.04em',
            cursor: p.googleLoading ? 'not-allowed' : 'pointer',
            opacity: p.googleLoading ? 0.7 : 1,
            fontFamily: 'inherit',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
          }}
        >
          <GoogleGlyph />
          {p.googleLoading ? 'Redirecting to Google…' : 'Continue with Google'}
        </button>

        <div
          style={{
            marginTop: 'auto',
            paddingTop: 28,
            fontSize: 11,
            color: 'var(--text)',
            textAlign: 'center',
            lineHeight: 1.55,
          }}
        >
          New here? Your account is created automatically when an admin invites you to the club.
        </div>
      </form>
    );
  }

  if (p.view === 'forgot') {
    return (
      <div style={{ flex: 1, padding: '0 24px 28px', display: 'flex', flexDirection: 'column' }}>
        <AuthHeader
          eyebrow="Recover access"
          title={
            <>
              Forgot
              <br />
              password?
            </>
          }
          sub="Enter your SFU email and we'll send a reset link."
          onBack={() => p.setView('signin')}
        />
        <div style={{ marginTop: 32 }}>
          <AuthField
            label="SFU Email"
            type="email"
            value={p.forgotEmail}
            onChange={p.setForgotEmail}
            placeholder="you@sfu.ca"
            error={p.errors.email}
            autoFocus
          />
          <CTAButton
            size="lg"
            full
            disabled={p.loading || !p.forgotEmail}
            onClick={p.onResetRequest}
          >
            {p.loading ? 'Sending…' : 'Send Reset Link'}
          </CTAButton>
          {p.errors.general && (
            <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 12, fontWeight: 600 }}>
              ↑ {p.errors.general}
            </div>
          )}
        </div>
      </div>
    );
  }

  // 'sent' (magic link) and 'reset-sent' (password reset) share the same
  // confirmation surface with slightly different copy.
  const isReset = p.view === 'reset-sent';
  const recipient = isReset ? p.forgotEmail : p.email || p.forgotEmail;
  const headline = isReset ? 'Reset link sent.' : 'Check your inbox.';
  const body = isReset
    ? `If a club account exists for that email, a reset link is on its way. It's good for 1 hour.`
    : `Tap the magic link we sent to sign in. Good for 1 hour.`;

  return (
    <div
      style={{
        flex: 1,
        padding: '24px 24px 28px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          border: '1px solid var(--green)',
          color: 'var(--green)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 32,
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        ✓
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.4px', marginTop: 22 }}>{headline}</div>
      <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.55, marginTop: 12, maxWidth: 280 }}>
        {body.split(recipient).map((part, i, arr) =>
          i < arr.length - 1 ? (
            <span key={i}>
              {part}
              <strong style={{ color: 'var(--ink)' }}>{recipient}</strong>
            </span>
          ) : (
            <span key={i}>{part}</span>
          )
        )}
      </div>
      <div style={{ marginTop: 36, width: '100%' }}>
        <CTAButton
          size="lg"
          full
          onClick={() => {
            p.setView('signin');
            p.setEmail('');
            p.setPassword('');
            p.setForgotEmail('');
          }}
        >
          Back to Sign In
        </CTAButton>
      </div>
    </div>
  );
}

// Google "G" multi-color glyph, sized for the auth button.
function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}

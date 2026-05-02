'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@badminton/shared/supabase-browser';
import {
  AuthShell,
  AuthHeader,
  AuthField,
  CTAButton,
  ShuttleMark,
} from '@/components/v2/atoms';

type View = 'signin' | 'forgot' | 'sent';

export default function LoginPage() {
  const [view, setView] = useState<View>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string; general?: string }>({});

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const next = params.get('next');
      if (next && next.startsWith('/')) {
        sessionStorage.setItem('qr_redirect', next);
      }
    } catch {
      /* no-op */
    }
  }, []);

  function buildCallbackUrl(): string {
    try {
      const next = new URLSearchParams(window.location.search).get('next');
      const base = `${window.location.origin}/auth/callback`;
      return next && next.startsWith('/') ? `${base}?next=${encodeURIComponent(next)}` : base;
    } catch {
      return `${window.location.origin}/auth/callback`;
    }
  }

  async function handleMagicLink(targetEmail: string) {
    setLoading(true);
    setErrors({});
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOtp({
      email: targetEmail,
      options: { emailRedirectTo: buildCallbackUrl() },
    });
    if (authError) {
      setErrors({
        general: authError.message.includes('rate')
          ? 'Too many attempts — please wait before trying again'
          : authError.message,
      });
      setLoading(false);
      return;
    }
    setLoading(false);
    setView('sent');
  }

  function handleSignin(e?: React.FormEvent) {
    e?.preventDefault();
    const errs: { email?: string; password?: string } = {};
    if (!email.trim()) errs.email = 'Required';
    else if (!/.+@.+\..+/.test(email)) errs.email = 'Invalid email';
    if (!password) errs.password = 'Required';
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    void handleMagicLink(email);
  }

  async function handleGoogleLogin() {
    setGoogleLoading(true);
    setErrors({});
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: buildCallbackUrl() },
    });
    if (authError) {
      setErrors({ general: authError.message });
      setGoogleLoading(false);
    }
  }

  // ── SIGN IN ─────────────────────────────────────────────
  if (view === 'signin') {
    return (
      <AuthShell>
        <form
          onSubmit={handleSignin}
          style={{
            flex: 1,
            padding: '36px 24px 28px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 36 }}>
            <ShuttleMark size={22} color="#da291c" />
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '2.5px',
                textTransform: 'uppercase',
                color: '#da291c',
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
              color: '#da291c',
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
          <div
            style={{
              fontSize: 13,
              color: '#969696',
              lineHeight: 1.55,
              marginTop: 14,
              marginBottom: 32,
            }}
          >
            Sign in to log matches, accept challenges, and check your ELO.
          </div>

          <AuthField
            label="SFU Email"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="you@sfu.ca"
            error={errors.email}
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
                  color: errors.password ? '#da291c' : '#666',
                }}
              >
                Password
              </div>
              <button
                type="button"
                onClick={() => setView('forgot')}
                style={{
                  background: 'transparent',
                  border: 0,
                  color: '#969696',
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
              type={showPass ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              style={{
                width: '100%',
                background: '#181818',
                border: '1px solid ' + (errors.password ? '#da291c' : '#303030'),
                color: '#fff',
                fontSize: 14,
                fontWeight: 500,
                padding: '13px 14px',
                paddingRight: 60,
                boxSizing: 'border-box',
              }}
            />
            <button
              type="button"
              onClick={() => setShowPass((s) => !s)}
              style={{
                position: 'absolute',
                right: 12,
                top: 32,
                background: 'transparent',
                border: 0,
                color: '#969696',
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {showPass ? 'Hide' : 'Show'}
            </button>
            {errors.password && (
              <div
                style={{
                  fontSize: 10,
                  color: '#da291c',
                  marginTop: 6,
                  fontWeight: 600,
                }}
              >
                ↑ {errors.password}
              </div>
            )}
          </div>

          <CTAButton size="lg" full disabled={loading} type="submit">
            {loading ? 'Sending magic link…' : 'Sign In'}
          </CTAButton>

          {errors.general && (
            <div style={{ fontSize: 10, color: '#da291c', marginTop: 12, fontWeight: 600 }}>
              ↑ {errors.general}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '24px 0' }}>
            <div style={{ flex: 1, height: 1, background: '#303030' }} />
            <span style={{ fontSize: 9, color: '#666', letterSpacing: '0.18em', fontWeight: 600 }}>
              OR
            </span>
            <div style={{ flex: 1, height: 1, background: '#303030' }} />
          </div>

          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={googleLoading}
            style={{
              width: '100%',
              background: 'transparent',
              color: '#fff',
              border: '1px solid #303030',
              padding: '14px',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '2px',
              textTransform: 'uppercase',
              cursor: googleLoading ? 'not-allowed' : 'pointer',
              opacity: googleLoading ? 0.6 : 1,
              fontFamily: 'inherit',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
            }}
          >
            <span
              style={{
                width: 16,
                height: 16,
                background: '#da291c',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'JetBrains Mono, monospace',
                fontWeight: 700,
                fontSize: 9,
                color: '#fff',
              }}
            >
              S
            </span>
            {googleLoading ? 'Redirecting…' : 'SFU SSO'}
          </button>

          <div
            style={{
              marginTop: 'auto',
              paddingTop: 28,
              fontSize: 12,
              color: '#969696',
              textAlign: 'center',
            }}
          >
            New to the club?{' '}
            <a
              href="/onboarding"
              style={{
                color: '#da291c',
                fontSize: 12,
                fontWeight: 700,
                textDecoration: 'none',
              }}
            >
              Join now →
            </a>
          </div>
        </form>
      </AuthShell>
    );
  }

  // ── FORGOT ─────────────────────────────────────────────
  if (view === 'forgot') {
    return (
      <AuthShell>
        <div
          style={{
            flex: 1,
            padding: '0 24px 28px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
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
            onBack={() => setView('signin')}
          />
          <div style={{ marginTop: 32 }}>
            <AuthField
              label="SFU Email"
              type="email"
              value={forgotEmail}
              onChange={setForgotEmail}
              placeholder="you@sfu.ca"
              autoFocus
            />
            <CTAButton
              size="lg"
              full
              disabled={loading || !forgotEmail}
              onClick={() => forgotEmail && handleMagicLink(forgotEmail)}
            >
              {loading ? 'Sending…' : 'Send Reset Link'}
            </CTAButton>
            {errors.general && (
              <div style={{ fontSize: 10, color: '#da291c', marginTop: 12, fontWeight: 600 }}>
                ↑ {errors.general}
              </div>
            )}
          </div>
        </div>
      </AuthShell>
    );
  }

  // ── SENT ───────────────────────────────────────────────
  return (
    <AuthShell>
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
            border: '1px solid #4ade80',
            color: '#4ade80',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 32,
            fontFamily: 'JetBrains Mono, monospace',
          }}
        >
          ✓
        </div>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.4px', marginTop: 22 }}>
          Check your inbox.
        </div>
        <div
          style={{
            fontSize: 13,
            color: '#969696',
            lineHeight: 1.55,
            marginTop: 12,
            maxWidth: 280,
          }}
        >
          If <strong style={{ color: '#fff' }}>{email || forgotEmail}</strong> matches a club account, a reset link is on
          its way. It&apos;s good for 1 hour.
        </div>
        <div style={{ marginTop: 36, width: '100%' }}>
          <CTAButton
            size="lg"
            full
            onClick={() => {
              setView('signin');
              setEmail('');
              setPassword('');
              setForgotEmail('');
            }}
          >
            Back to Sign In
          </CTAButton>
        </div>
      </div>
    </AuthShell>
  );
}

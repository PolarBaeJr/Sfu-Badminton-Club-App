'use client';

import { useState } from 'react';
import { createClient } from '@badminton/shared/supabase-browser';

type View = 'signin' | 'request' | 'request-sent' | 'sent';

export default function LoginPage() {
  const [view, setView] = useState<View>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string; general?: string }>({});

  // Request access fields
  const [reqName, setReqName] = useState('');
  const [reqEmail, setReqEmail] = useState('');
  const [reqRole, setReqRole] = useState('');
  const [reqMessage, setReqMessage] = useState('');
  const [reqErrors, setReqErrors] = useState<Record<string, string>>({});

  async function handleSso() {
    setSsoLoading(true);
    setErrors({});
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (authError) {
      setErrors({ general: authError.message });
      setSsoLoading(false);
    }
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    const errs: { email?: string; password?: string } = {};
    if (!email.trim()) errs.email = 'This field is required';
    else if (!/.+@.+\..+/.test(email)) errs.email = 'Invalid email';
    if (!password) errs.password = 'This field is required';
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setLoading(true);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (authError) {
      setErrors({ general: authError.message });
      setLoading(false);
      return;
    }
    setLoading(false);
    setView('sent');
  }

  function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!reqName.trim()) errs.name = 'This field is required';
    if (!reqEmail.trim()) errs.email = 'This field is required';
    if (!reqRole.trim()) errs.role = 'This field is required';
    if (!reqMessage.trim()) errs.message = 'This field is required';
    setReqErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setView('request-sent');
  }

  return (
    <div className="auth-root">
      {/* Left brand panel */}
      <div className="auth-left-panel">
        <div className="auth-brand">
          <div className="auth-mark-sq">S</div>
          <span className="auth-club">SFU Badminton · Admin</span>
        </div>
        <h1 className="auth-headline">
          <span>Run your</span>
          <span>club like</span>
          <span>a team.</span>
        </h1>
        <span className="auth-season">Season 02 · Spring 2026</span>
        <div className="auth-foot-copy">© {new Date().getFullYear()} SFU Badminton Club</div>
      </div>

      {/* Right form panel */}
      <div className="auth-right-panel">
        <div className="auth-form">
          {view === 'signin' && (
            <form onSubmit={handleSignIn} noValidate>
              <div className="auth-eyebrow">Welcome back</div>
              <h2 className="auth-title">Sign in.</h2>
              <div style={{ height: 32 }} />

              <label className="auth-label">Email Address</label>
              <div className="auth-input-wrap">
                <input
                  className="auth-input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@sfu.ca"
                  autoComplete="email"
                  style={{
                    borderColor: errors.email ? 'var(--red)' : undefined,
                  }}
                />
              </div>
              {errors.email && <div className="auth-error-show">↑ {errors.email}</div>}

              <label className="auth-label">Password</label>
              <div className="auth-input-wrap">
                <input
                  className="auth-input"
                  type={showPass ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  style={{
                    paddingRight: 60,
                    borderColor: errors.password ? 'var(--red)' : undefined,
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPass((s) => !s)}
                  className="auth-pass-toggle"
                >
                  {showPass ? 'Hide' : 'Show'}
                </button>
              </div>
              {errors.password && <div className="auth-error-show">↑ {errors.password}</div>}

              <button
                type="button"
                onClick={() => setView('signin')}
                className="auth-forgot"
                style={{ background: 'transparent', border: 0, padding: 0 }}
              >
                Forgot password?
              </button>

              <button type="submit" className="auth-btn" disabled={loading}>
                {loading ? 'Authenticating…' : 'Sign In'}
              </button>

              {errors.general && (
                <div className="auth-error-show" style={{ marginTop: 12 }}>
                  ↑ {errors.general}
                </div>
              )}

              <div className="auth-divider">
                <span>OR</span>
              </div>

              <button
                type="button"
                className="auth-btn auth-btn-ghost"
                onClick={handleSso}
                disabled={ssoLoading}
              >
                <span className="auth-sso-mark">S</span>
                {ssoLoading ? 'Redirecting…' : 'Sign In with SFU SSO'}
              </button>

              <div className="auth-foot">
                Don&apos;t have an account?{' '}
                <a onClick={() => setView('request')}>Join the club →</a>
              </div>
              <div className="auth-note">
                Admin access is restricted to authorized SFU Badminton executive members.
              </div>
            </form>
          )}

          {view === 'sent' && (
            <div className="auth-success">
              <div className="auth-success-check">✓</div>
              <div className="auth-success-title">Check your email.</div>
              <div className="auth-success-body">
                We sent a sign-in link to <strong style={{ color: '#F0F0F0' }}>{email}</strong>. Open it on this device
                to continue.
              </div>
              <a
                className="auth-success-back"
                onClick={() => {
                  setView('signin');
                  setEmail('');
                  setPassword('');
                }}
              >
                ← Back to sign in
              </a>
            </div>
          )}

          {view === 'request' && (
            <form onSubmit={handleRequest} noValidate>
              <div className="auth-eyebrow">Admin access</div>
              <h2 className="auth-title">Request access.</h2>
              <p className="auth-lede">
                Admin accounts are created by the Super Admin only. Submit your details and you will be contacted.
              </p>

              <label className="auth-label">Full Name</label>
              <div className="auth-input-wrap">
                <input
                  className="auth-input"
                  value={reqName}
                  onChange={(e) => setReqName(e.target.value)}
                  placeholder="Your full name"
                  style={{ borderColor: reqErrors.name ? 'var(--red)' : undefined }}
                />
              </div>
              {reqErrors.name && <div className="auth-error-show">↑ {reqErrors.name}</div>}

              <label className="auth-label">SFU Email</label>
              <div className="auth-input-wrap">
                <input
                  className="auth-input"
                  type="email"
                  value={reqEmail}
                  onChange={(e) => setReqEmail(e.target.value)}
                  placeholder="you@sfu.ca"
                  style={{ borderColor: reqErrors.email ? 'var(--red)' : undefined }}
                />
              </div>
              {reqErrors.email && <div className="auth-error-show">↑ {reqErrors.email}</div>}

              <label className="auth-label">Role / Position</label>
              <div className="auth-input-wrap">
                <input
                  className="auth-input"
                  value={reqRole}
                  onChange={(e) => setReqRole(e.target.value)}
                  placeholder="e.g. Club President"
                  style={{ borderColor: reqErrors.role ? 'var(--red)' : undefined }}
                />
              </div>
              {reqErrors.role && <div className="auth-error-show">↑ {reqErrors.role}</div>}

              <label className="auth-label">Message</label>
              <div className="auth-input-wrap">
                <textarea
                  className="auth-input"
                  rows={4}
                  value={reqMessage}
                  onChange={(e) => setReqMessage(e.target.value)}
                  placeholder="Why do you need admin access?"
                  style={{
                    borderColor: reqErrors.message ? 'var(--red)' : undefined,
                    resize: 'vertical',
                    minHeight: 96,
                  }}
                />
              </div>
              {reqErrors.message && <div className="auth-error-show">↑ {reqErrors.message}</div>}

              <button type="submit" className="auth-btn">Send Request</button>
              <div className="auth-foot">
                Already have an account? <a onClick={() => setView('signin')}>Sign in →</a>
              </div>
            </form>
          )}

          {view === 'request-sent' && (
            <div className="auth-success">
              <div className="auth-success-check">✓</div>
              <div className="auth-success-title">Request sent.</div>
              <div className="auth-success-body">
                The Super Admin will review your request and contact you at your SFU email within 48 hours.
              </div>
              <a className="auth-success-back" onClick={() => setView('signin')}>← Back to sign in</a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

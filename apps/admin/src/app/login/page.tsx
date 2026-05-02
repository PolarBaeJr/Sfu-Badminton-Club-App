'use client';

import { useState } from 'react';
import { createClient } from '@badminton/shared/supabase-browser';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function handleGoogleLogin() {
    setGoogleLoading(true);
    setError('');
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (authError) {
      setError(authError.message);
      setGoogleLoading(false);
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (authError) setError(authError.message);
    else setSent(true);
    setLoading(false);
  }

  return (
    <div
      className="fixed inset-0 flex flex-col md:flex-row"
      style={{ background: 'var(--bg)', zIndex: 200 }}
    >
      {/* Left panel */}
      <div
        className="flex-1 min-w-0 relative overflow-hidden flex flex-col justify-center"
        style={{
          background: '#0A0A0A',
          padding: '60px',
        }}
      >
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, transparent, transparent 39px, rgba(255,255,255,0.03) 39px, rgba(255,255,255,0.03) 40px)',
          }}
        />
        <div className="relative" style={{ maxWidth: 440 }}>
          <div className="flex items-center gap-[10px]">
            <span
              className="flex items-center justify-center"
              style={{
                width: 40, height: 40, background: 'var(--red)', color: '#fff',
                fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22,
              }}
            >S</span>
          </div>
          <span
            className="block uppercase font-bold"
            style={{ marginTop: 12, fontSize: 11, letterSpacing: '0.25em', color: 'var(--red)' }}
          >
            SFU Badminton · Admin
          </span>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              fontSize: 72,
              lineHeight: 0.92,
              color: '#F0F0F0',
              letterSpacing: '-0.02em',
              marginTop: 32,
            }}
          >
            <span className="block">Run your</span>
            <span className="block">club like</span>
            <span className="block">a team.</span>
          </h1>
          <span
            className="inline-block uppercase font-bold"
            style={{ marginTop: 32, fontSize: 10, letterSpacing: '0.2em', color: 'var(--red)' }}
          >
            Season 02 · Spring 2026
          </span>
        </div>
        <div
          className="absolute"
          style={{ left: 60, bottom: 40, fontSize: 10, color: '#2A2A2A', letterSpacing: '0.06em' }}
        >
          © {new Date().getFullYear()} SFU Badminton Club
        </div>
      </div>

      {/* Right panel */}
      <div
        className="flex-1 min-w-0 flex items-center justify-center overflow-y-auto"
        style={{
          background: '#111111',
          borderLeft: '1px solid rgba(255,255,255,0.06)',
          padding: '60px 40px',
        }}
      >
        <div className="w-full" style={{ maxWidth: 380 }}>
          {sent ? (
            <>
              <span
                className="uppercase font-bold"
                style={{ fontSize: 10, letterSpacing: '0.2em', color: 'var(--red)' }}
              >
                Magic Link Sent
              </span>
              <h2
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 700,
                  fontSize: 36,
                  color: '#F0F0F0',
                  marginTop: 8,
                  lineHeight: 1,
                  letterSpacing: '-0.01em',
                }}
              >Check your email.</h2>
              <p style={{ fontSize: 12, color: '#888', lineHeight: 1.6, marginTop: 14 }}>
                We sent a sign-in link to <strong style={{ color: '#F0F0F0' }}>{email}</strong>.
                Open it on this device to continue.
              </p>
              <button
                type="button"
                onClick={() => { setSent(false); setEmail(''); }}
                className="mt-8 uppercase font-bold"
                style={{ fontSize: 11, letterSpacing: '0.16em', color: 'var(--muted)', fontFamily: 'var(--font-display)' }}
              >← Use a different email</button>
            </>
          ) : (
            <>
              <span
                className="uppercase font-bold"
                style={{ fontSize: 10, letterSpacing: '0.2em', color: 'var(--red)' }}
              >Welcome back</span>
              <h2
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 700,
                  fontSize: 36,
                  color: '#F0F0F0',
                  marginTop: 8,
                  lineHeight: 1,
                  letterSpacing: '-0.01em',
                }}
              >Sign in.</h2>
              <p style={{ fontSize: 12, color: '#555', lineHeight: 1.6, marginTop: 14, marginBottom: 32 }}>
                Sign in with a magic link or Google. Admin access is required.
              </p>

              <form onSubmit={handleMagicLink}>
                <label
                  className="block uppercase font-bold"
                  style={{ fontSize: 9, letterSpacing: '0.15em', color: '#555', marginBottom: 6 }}
                >Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@sfu.ca"
                  required
                  className="w-full outline-none"
                  style={{
                    background: '#0D0D0D',
                    border: `1px solid ${error ? 'var(--red)' : 'rgba(255,255,255,0.10)'}`,
                    color: '#F0F0F0',
                    fontFamily: 'var(--font-body)',
                    fontSize: 13,
                    fontWeight: 400,
                    padding: '12px 14px',
                    transition: 'border-color 150ms ease-out',
                    marginBottom: error ? 10 : 24,
                    boxSizing: 'border-box',
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--red)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = error ? 'var(--red)' : 'rgba(255,255,255,0.10)'; }}
                />
                {error && (
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--red)',
                      letterSpacing: '0.04em',
                      marginBottom: 16,
                    }}
                  >{error}</div>
                )}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full uppercase font-bold inline-flex items-center justify-center gap-[10px]"
                  style={{
                    background: 'var(--red)',
                    color: '#fff',
                    fontFamily: 'var(--font-display)',
                    fontSize: 11,
                    letterSpacing: '0.16em',
                    padding: '12px 16px',
                    border: 0,
                    cursor: loading ? 'not-allowed' : 'pointer',
                    opacity: loading ? 0.6 : 1,
                    transition: 'background 150ms ease-out, opacity 150ms ease-out',
                  }}
                >
                  {loading ? 'Sending…' : 'Send magic link'}
                </button>
              </form>

              {/* OR Divider */}
              <div className="flex items-center gap-3 my-6">
                <span className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />
                <span
                  className="uppercase"
                  style={{ fontSize: 10, letterSpacing: '0.2em', color: 'var(--faint)' }}
                >or</span>
                <span className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />
              </div>

              <button
                type="button"
                onClick={handleGoogleLogin}
                disabled={googleLoading}
                className="w-full uppercase font-bold inline-flex items-center justify-center gap-[10px]"
                style={{
                  background: 'transparent',
                  color: 'var(--text)',
                  fontFamily: 'var(--font-display)',
                  fontSize: 11,
                  letterSpacing: '0.16em',
                  padding: '12px 16px',
                  border: '1px solid var(--hairline)',
                  cursor: googleLoading ? 'not-allowed' : 'pointer',
                  opacity: googleLoading ? 0.6 : 1,
                  transition: 'border-color 150ms ease-out, color 150ms ease-out',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--hairline-strong)'; e.currentTarget.style.color = 'var(--ink)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--hairline)'; e.currentTarget.style.color = 'var(--text)'; }}
              >
                {googleLoading ? 'Redirecting…' : 'Continue with Google'}
              </button>

              <p
                className="mt-8"
                style={{ fontSize: 10, color: '#333', letterSpacing: '0.06em' }}
              >
                Admin access is granted by invitation. Contact a club captain to request access.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

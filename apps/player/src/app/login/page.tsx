'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { Mail, CheckCircle2, ChevronRight, Loader2 } from 'lucide-react';

export default function LoginPage() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
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
    if (authError) {
      setError(authError.message.includes('rate') ? 'Too many attempts — please wait before trying again' : authError.message);
    } else {
      setSent(true);
    }
    setLoading(false);
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)',
        background: 'var(--bg)',
      }}
      className="auth"
    >
      <div
        style={{
          padding: 80,
          background: 'var(--ink)',
          color: 'var(--bg)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          position: 'relative',
          overflow: 'hidden',
        }}
        className="auth-panel"
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'radial-gradient(ellipse at bottom right, rgba(204,6,51,.3), transparent 60%)',
            pointerEvents: 'none',
          }}
        />
        <div className="brand" style={{ color: '#fff', position: 'relative', zIndex: 2 }}>
          <div className="brand-mark">SB</div>
          <div className="brand-wrap">
            <div>SFU Badminton</div>
            <div className="brand-sub" style={{ color: 'rgba(255,255,255,.5)' }}>Club · Season 26</div>
          </div>
        </div>

        <div style={{ position: 'relative', zIndex: 2 }}>
          <div className="page-eyebrow" style={{ color: 'rgba(255,255,255,.6)', marginBottom: 14 }}>
            <span className="bar" style={{ background: 'rgba(255,255,255,.6)' }} /> CHALLENGE · COMPETE · CLIMB
          </div>
          <div
            style={{
              fontFamily: 'var(--display)',
              fontSize: 'clamp(40px, 7vw, 88px)',
              fontWeight: 700,
              letterSpacing: '-.04em',
              lineHeight: 0.9,
            }}
            className="auth-hero"
          >
            Singles. Doubles.<br />
            <span style={{ color: 'var(--red)' }}>Every rally counted.</span>
          </div>
          <div
            style={{
              maxWidth: '46ch',
              marginTop: 20,
              color: 'rgba(255,255,255,.7)',
              fontSize: 15,
              lineHeight: 1.6,
            }}
          >
            ELO ratings, head-to-head ledgers, tournament brackets, ladder climbs. Your full club profile.
          </div>
        </div>

        <div className="row" style={{ gap: 24, fontSize: 12, color: 'rgba(255,255,255,.5)', position: 'relative', zIndex: 2, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '.1em' }}>
          <span>Est. 2011</span>
          <span>SRC Gym · Burnaby BC</span>
          <span>Season 26</span>
        </div>
      </div>

      <div
        style={{
          padding: 80,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 24,
          maxWidth: 520,
          width: '100%',
          margin: '0 auto',
        }}
        className="auth-form"
      >
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
              ? 'We\'ll email you a one-time link. No password to remember.'
              : 'Join the club roster. We\'ll send a magic link to get you in.'}
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
          <div className="card-base" style={{ textAlign: 'center', padding: 32 }}>
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
            <div style={{ fontFamily: 'var(--display)', fontSize: 22, fontWeight: 700 }}>Check your email</div>
            <div className="page-sub" style={{ marginTop: 8 }}>
              We sent a magic link to <strong>{email}</strong>.
            </div>
            <button
              type="button"
              onClick={() => setSent(false)}
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 14 }}
            >
              Use a different email
            </button>
          </div>
        ) : (
          <>
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
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@sfu.ca"
                  required
                  style={{
                    width: '100%',
                    padding: '14px 16px 14px 38px',
                    borderRadius: 10,
                    border: '1px solid var(--line)',
                    background: 'var(--surface)',
                    fontSize: 14,
                    transition: 'border .15s',
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--ink)')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--line)')}
                />
              </div>
              {error && (
                <div
                  style={{
                    fontSize: 13,
                    color: 'var(--loss)',
                    background: 'var(--red-wash)',
                    padding: '10px 12px',
                    borderRadius: 8,
                  }}
                >
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={loading}
                className="btn btn-primary btn-lg"
                style={{ width: '100%', justifyContent: 'center', height: 48 }}
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Mail size={14} />}
                Send magic link
                {!loading && <ChevronRight size={14} />}
              </button>
            </form>

            <div className="muted" style={{ fontSize: 12, textAlign: 'center' }}>
              {mode === 'signin' ? (
                <>
                  No account yet?{' '}
                  <button onClick={() => { setMode('signup'); setError(''); }} type="button" style={{ color: 'var(--red)', fontWeight: 600 }}>
                    Sign up
                  </button>
                </>
              ) : (
                <>
                  Already have one?{' '}
                  <button onClick={() => { setMode('signin'); setError(''); }} type="button" style={{ color: 'var(--red)', fontWeight: 600 }}>
                    Sign in
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

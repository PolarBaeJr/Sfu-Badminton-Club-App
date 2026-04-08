'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { Button, Input, Card } from '@badminton/ui';
import { Shield, Mail, Loader2, Globe, CheckCircle2, AlertCircle } from 'lucide-react';

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
            <div className="text-center py-6">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full mb-4" style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)' }}>
                <CheckCircle2 className="w-8 h-8 text-[#10B981]" />
              </div>
              <p className="text-[#10B981] font-semibold text-lg mb-1">Check your email!</p>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Magic link sent to{' '}
                <strong style={{ color: 'var(--text-primary)' }}>{email}</strong>
              </p>
            </div>
          ) : (
            <div className="space-y-6">
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

              {/* Magic Link Form */}
              <form onSubmit={handleMagicLink} className="space-y-4">
                <div className="relative">
                  <Input
                    label="Email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@sfu.ca"
                    required
                  />
                </div>

                {/* Error State */}
                {error && (
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
                )}

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
                  Send Magic Link
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

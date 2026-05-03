'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@badminton/shared/supabase-browser';
import { AuthHeader, AuthShell } from '@/components/v2/atoms-layout';
import { CTAButton } from '@/components/v2/atoms-form';

const IGNITION_MS = 220;

export default function ResetPasswordPage() {
  const router = useRouter();
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [errors, setErrors] = useState<{ password?: string; confirm?: string; general?: string }>({});

  // Recovery flow: by the time we land here the auth callback has already
  // exchanged the recovery code for a session and set the cookies. If there's
  // no session, the link expired or someone deep-linked here directly.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setHasSession(!!data.session);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function validate(): boolean {
    const errs: typeof errors = {};
    if (password.length < 8) errs.password = 'Use at least 8 characters';
    if (confirm !== password) errs.confirm = 'Passwords don’t match';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (authError) {
      setErrors({
        general: authError.message.toLowerCase().includes('weak')
          ? 'Password is too weak — try a longer one'
          : authError.message,
      });
      return;
    }
    // Success — ignite + redirect to /feed.
    setRedirecting(true);
    window.setTimeout(() => {
      router.push('/feed');
      router.refresh();
    }, IGNITION_MS);
  }

  // ── Loading: show a quiet shell while we check the session ──
  if (hasSession === null) {
    return (
      <AuthShell>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text)',
            fontSize: 12,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
          }}
        >
          Loading…
        </div>
      </AuthShell>
    );
  }

  // ── No recovery session — link expired or deep-linked ──
  if (!hasSession) {
    return (
      <AuthShell>
        <div style={{ flex: 1, padding: '0 24px 28px', display: 'flex', flexDirection: 'column' }}>
          <AuthHeader
            eyebrow="Link expired"
            title={
              <>
                Reset link
                <br />
                no longer valid.
              </>
            }
            sub="Reset links are good for 1 hour and can only be used once. Request a fresh one from the sign-in page."
          />
          <div style={{ marginTop: 32 }}>
            <Link href="/login" style={{ display: 'block', width: '100%' }}>
              <CTAButton size="lg" full>
                Back to Sign In
              </CTAButton>
            </Link>
          </div>
        </div>
      </AuthShell>
    );
  }

  // ── Active recovery session — set new password ──
  const body = (
    <form
      onSubmit={handleSubmit}
      style={{ flex: 1, padding: '0 24px 28px', display: 'flex', flexDirection: 'column' }}
    >
      <AuthHeader
        eyebrow="Set new password"
        title={
          <>
            Choose a
            <br />
            new password.
          </>
        }
        sub="At least 8 characters. Pick something you can remember."
      />
      <div style={{ marginTop: 32, position: 'relative' }}>
        <Field
          label="New password"
          value={password}
          onChange={setPassword}
          showPass={showPass}
          onToggleShow={() => setShowPass((s) => !s)}
          error={errors.password}
          autoFocus
        />
        <Field
          label="Confirm password"
          value={confirm}
          onChange={setConfirm}
          showPass={showPass}
          onToggleShow={() => setShowPass((s) => !s)}
          error={errors.confirm}
        />
        <CTAButton size="lg" full disabled={loading} type="submit">
          {loading ? 'Updating…' : 'Update Password'}
        </CTAButton>
        {errors.general && (
          <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 12, fontWeight: 600 }}>
            ↑ {errors.general}
          </div>
        )}
      </div>
    </form>
  );

  return (
    <div
      style={{
        opacity: redirecting ? 0 : 1,
        transition: `opacity ${IGNITION_MS}ms ease-out`,
      }}
    >
      <AuthShell>{body}</AuthShell>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  showPass,
  onToggleShow,
  error,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  showPass: boolean;
  onToggleShow: () => void;
  error?: string;
  autoFocus?: boolean;
}) {
  return (
    <div style={{ marginBottom: 18, position: 'relative' }}>
      <div
        style={{
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: '1.5px',
          textTransform: 'uppercase',
          color: error ? 'var(--red)' : 'var(--dim)',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <input
        type={showPass ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="••••••••"
        autoComplete="new-password"
        autoFocus={autoFocus}
        style={{
          width: '100%',
          background: 'var(--surface1)',
          border: '1px solid ' + (error ? 'var(--red)' : 'var(--hairline)'),
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
        onClick={onToggleShow}
        style={{
          position: 'absolute',
          right: 12,
          top: 26,
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
        {showPass ? 'Hide' : 'Show'}
      </button>
      {error && (
        <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 6, fontWeight: 600 }}>
          ↑ {error}
        </div>
      )}
    </div>
  );
}

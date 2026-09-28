'use client';

import { Loader2, Mail } from 'lucide-react';

// The "Enter your code" screen, shared by /login and /signup. The copy props
// default to the sign-in wording; the password confirmation screens on forgot
// password and signup reuse it with their own words.
export function CodeStep({
  email,
  code,
  onCodeChange,
  onSubmit,
  onResend,
  onChangeEmail,
  loading,
  resending,
  error,
  submitLabel,
  sentNotice,
  title = 'Enter your code',
  lead,
  codeLabel = 'Sign-in code',
  altLabel = 'Use a different email',
}: {
  email: string;
  code: string;
  onCodeChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onResend: () => void;
  onChangeEmail: () => void;
  loading: boolean;
  resending: boolean;
  error: string;
  submitLabel: string;
  sentNotice: string | null;
  title?: string;
  lead?: React.ReactNode;
  codeLabel?: string;
  altLabel?: string;
}) {
  return (
    <div>
      <div style={{ textAlign: 'center' }}>
        <div className="signin-icon"><Mail size={28} /></div>
        <div style={{ fontFamily: 'var(--display)', fontSize: 22, fontWeight: 700 }}>{title}</div>
        <div className="page-sub" style={{ marginTop: 8, marginInline: 'auto' }}>
          {lead ?? <>We emailed a 6-digit code to <strong>{email}</strong>.</>}
        </div>
      </div>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 18 }}>
        <label htmlFor="code" className="sr-only">{codeLabel}</label>
        <input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={(e) => onCodeChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="123456"
          className="input-base signin-code"
        />
        {sentNotice && <div className="signin-notice" role="status">{sentNotice}</div>}
        {error && <div className="alert-danger" role="alert">{error}</div>}
        <button type="submit" disabled={loading || code.length < 6} className="btn btn-primary btn-lg signin-cta">
          {loading ? <Loader2 size={16} className="animate-spin" /> : null}
          {submitLabel}
        </button>
      </form>
      <div className="signin-links" style={{ marginTop: 14 }}>
        <button type="button" onClick={onResend} disabled={loading || resending}>Send a new code</button>
        <span aria-hidden>·</span>
        <button type="button" onClick={onChangeEmail}>{altLabel}</button>
      </div>
    </div>
  );
}

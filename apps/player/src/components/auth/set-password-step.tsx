'use client';

import { useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { PASSWORD_MIN_LENGTH, passwordProblem, withErrorCode } from '@badminton/shared';
import { PasswordField } from './password-field';

// The "Choose a password" screen, shown once an emailed code has signed the
// member in: after a signup whose password was refused, and on forgot-password.
export function SetPasswordStep({
  onSubmit,
  loading,
  error,
  submitLabel,
  lead,
  onSkip,
  skipLabel = 'Skip for now',
}: {
  onSubmit: (password: string) => void;
  loading: boolean;
  error: string;
  submitLabel: string;
  lead?: string;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const p = passwordProblem(password);
    if (p) {
      setProblem(withErrorCode(p, 'AUTH-212'));
      return;
    }
    setProblem('');
    onSubmit(password);
  }

  const shown = problem || error;
  return (
    <div>
      <div style={{ textAlign: 'center' }}>
        <div className="signin-icon"><Lock size={28} /></div>
        <div style={{ fontFamily: 'var(--display)', fontSize: 22, fontWeight: 700 }}>Choose a password</div>
        {lead && (
          <div className="page-sub" style={{ marginTop: 8, marginInline: 'auto' }}>
            {lead}
          </div>
        )}
      </div>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 18 }}>
        <PasswordField
          id="new-password"
          value={password}
          onChange={(v) => { setPassword(v); setProblem(''); }}
          autoComplete="new-password"
          required
          label="New password"
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        />
        {shown && <div className="alert-danger" role="alert">{shown}</div>}
        <button type="submit" disabled={loading} className="btn btn-primary btn-lg signin-cta">
          {loading ? <Loader2 size={16} className="animate-spin" /> : null}
          {submitLabel}
        </button>
      </form>
      {onSkip && (
        <div className="signin-links" style={{ marginTop: 14 }}>
          <button type="button" onClick={onSkip} disabled={loading}>{skipLabel}</button>
        </div>
      )}
    </div>
  );
}

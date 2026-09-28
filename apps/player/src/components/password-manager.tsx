'use client';

import { useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { PASSWORD_MIN_LENGTH } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { PasswordField } from '@/components/auth/password-field';
import { usePasswordSave } from '@/lib/use-password-save';

// "Set or change password". The client cannot tell whether a password exists
// (a code-only member has an email identity too), so one control does both.
//
// The emailed confirmation code is the MAIN path, not an edge case: GoTrue
// asks for it on any session older than its reauthentication window, and most
// members' sessions are.
export function PasswordManager() {
  const [password, setPassword] = useState('');
  const { toast } = useToast();
  const pw = usePasswordSave({
    onSaved: () => {
      toast('Password saved', 'success');
      setPassword('');
    },
  });
  const { step, nonce, setNonce, busy, error, notice } = pw;

  function reset() {
    setPassword('');
    pw.cancel();
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    void pw.submitPassword(password);
  }

  function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    void pw.submitCode();
  }

  function handleResend() {
    void pw.resendCode();
  }

  if (step === 'code') {
    return (
      <form onSubmit={handleConfirm} className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
        <div>
          <div className="settings-row-label">Confirm it is you</div>
          <div className="settings-row-hint">We emailed you a 6-digit code to confirm the password change.</div>
        </div>
        <label htmlFor="password-nonce" className="sr-only">Confirmation code</label>
        <input
          id="password-nonce"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={nonce}
          onChange={(e) => setNonce(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="123456"
          className="input-base"
        />
        {notice && <div className="settings-row-hint" role="status">{notice}</div>}
        {error && <div className="settings-row-hint" role="alert" style={{ color: 'var(--red)' }}>{error}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="submit" disabled={busy || nonce.length < 6} className="btn btn-primary btn-sm">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
            Save password
          </button>
          <button type="button" onClick={() => void handleResend()} disabled={busy} className="btn btn-ghost btn-sm">
            Send a new code
          </button>
          <button type="button" onClick={reset} disabled={busy} className="btn btn-ghost btn-sm">
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleSave} className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
      <div>
        <div className="settings-row-label">Set or change password</div>
        <div className="settings-row-hint">
          Sign in with your email and a password. Email codes and passkeys keep working.
        </div>
      </div>
      <PasswordField
        id="settings-password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        label="New password"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
      />
      {error && <div className="settings-row-hint" role="alert" style={{ color: 'var(--red)' }}>{error}</div>}
      <div>
        <button type="submit" disabled={busy || !password} className="btn btn-ghost btn-sm">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
          Save password
        </button>
      </div>
    </form>
  );
}

'use client';

import { useState } from 'react';
import { Eye, EyeOff, Lock } from 'lucide-react';
import { PASSWORD_MAX_LENGTH } from '@badminton/shared';

// A labelled password input with a show/hide toggle, shared by sign-in,
// sign-up, forgot-password and Settings.
export function PasswordField({
  id,
  value,
  onChange,
  autoComplete,
  required,
  hint,
  label = 'Password',
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  required?: boolean;
  hint?: string;
  label?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <label htmlFor={id} className="mono muted" style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' }}>
        {label}
      </label>
      <div style={{ position: 'relative' }}>
        <Lock
          size={16}
          className="text-[var(--mute)]"
          style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}
        />
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          maxLength={PASSWORD_MAX_LENGTH}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="input-base"
          style={{ paddingLeft: 38, paddingRight: 44 }}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          className="text-[var(--mute)]"
          style={{
            position: 'absolute',
            right: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'none',
            border: 0,
            padding: 6,
            cursor: 'pointer',
            display: 'flex',
          }}
        >
          {shown ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {hint && (
        <div id={`${id}-hint`} className="muted" style={{ fontSize: 12, marginTop: -6 }}>
          {hint}
        </div>
      )}
    </>
  );
}

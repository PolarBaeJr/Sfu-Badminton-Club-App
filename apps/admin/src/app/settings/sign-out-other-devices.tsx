'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
// Deep import, not the '@badminton/shared' barrel: see the player middleware.
import { signOutOtherDevices } from '@badminton/shared/src/utils/sign-out';

// Revokes every session but this one. The console and the member app share one
// cookie per browser, so it ends both apps everywhere else and neither here.
// No redirect: this browser stays signed in.
export function SignOutOtherDevices() {
  const [state, setState] = useState<'idle' | 'confirming' | 'pending' | 'done' | 'error'>('idle');

  async function handleConfirm() {
    setState('pending');
    try {
      const { error } = await signOutOtherDevices(createClient().auth);
      setState(error ? 'error' : 'done');
    } catch {
      setState('error');
    }
  }

  const outline =
    'inline-flex min-h-[40px] items-center justify-center whitespace-nowrap rounded-[8px] border px-4 text-[11px] font-bold uppercase tracking-[0.14em] transition-colors disabled:opacity-50';

  return (
    <div className="flex flex-col items-end gap-2">
      {state === 'confirming' || state === 'pending' ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-[13px] text-[var(--ink-2)]">Sign out every other device?</span>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={state === 'pending'}
            className={`${outline} border-[color-mix(in_srgb,var(--red)_50%,transparent)] text-[var(--red)] hover:bg-[var(--red-wash)]`}
          >
            {state === 'pending' ? 'Signing out' : 'Confirm'}
          </button>
          <button
            type="button"
            onClick={() => setState('idle')}
            disabled={state === 'pending'}
            className={`${outline} border-[var(--line)] text-[var(--ink-2)] hover:bg-[var(--surface-2)]`}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setState('confirming')}
          className={`${outline} border-[color-mix(in_srgb,var(--red)_50%,transparent)] text-[var(--red)] hover:bg-[var(--red-wash)]`}
        >
          Sign out other devices
        </button>
      )}
      {state === 'done' && (
        <p role="status" className="text-[12px] text-[var(--color-success)]">
          Signed out on every other device. You are still signed in here.
        </p>
      )}
      {state === 'error' && (
        <p role="alert" className="text-[12px] text-[var(--red)]">
          Could not sign out other devices. Try again.
        </p>
      )}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Loader2, LogOut } from 'lucide-react';
import { createClient } from '@/lib/supabase-browser';
// Deep import, not the '@badminton/shared' barrel: see the player middleware.
import { signOutOtherDevices } from '@badminton/shared/src/utils/sign-out';

// The Settings row that revokes every session but this one. The console and
// this app share one cookie per browser, so it ends both apps everywhere else
// and neither here. No redirect: this browser stays signed in.
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

  return (
    <div className="settings-row">
      <div>
        <div className="settings-row-label">Sign out other devices</div>
        <div className="settings-row-hint">
          Ends your console and member-app sessions on every other device. You stay signed in here.
        </div>
        {state === 'done' && (
          <div className="settings-row-hint" role="status">
            Signed out on every other device. You are still signed in here.
          </div>
        )}
        {state === 'error' && (
          <div className="settings-row-hint" role="alert" style={{ color: 'var(--red)' }}>
            Could not sign out other devices. Try again.
          </div>
        )}
      </div>
      <div className="settings-row-control">
        {state === 'confirming' || state === 'pending' ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <span className="settings-row-hint">Sign out every other device?</span>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={state === 'pending'}
              className="btn btn-danger-ghost"
            >
              {state === 'pending' ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setState('idle')}
              disabled={state === 'pending'}
              className="btn btn-ghost"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setState('confirming')} className="btn btn-danger-ghost">
            <LogOut size={14} />
            Sign out other devices
          </button>
        )}
      </div>
    </div>
  );
}

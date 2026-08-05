'use client';

import { useEffect, useState } from 'react';
import { KeyRound, Loader2, X } from 'lucide-react';
import { useToast } from '@/components/toast-provider';
import { enrollPasskey, supportsPasskeys } from '@/lib/passkey-client';
import { listPasskeys } from '@/lib/actions/passkeys';

// Everyone who signed up before passkeys existed skipped the onboarding offer,
// so this is how they get asked. Dismissal is remembered locally and for good —
// a nudge that reappears after being refused is just nagging. Settings keeps a
// permanent entry point for anyone who changes their mind later.
const DISMISSED_KEY = 'passkey-nudge-dismissed';

export function PasskeyNudge() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supportsPasskeys()) return;
      try {
        if (localStorage.getItem(DISMISSED_KEY)) return;
      } catch {
        // Private browsing can throw on localStorage; just show the nudge.
      }
      const res = await listPasskeys();
      if (cancelled) return;
      // Only for people with none. Anyone already enrolled never sees this.
      if (res.ok && res.data.length === 0) setVisible(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Non-fatal: it reappears next visit rather than breaking the page.
    }
    setVisible(false);
  }

  async function handleAdd() {
    setBusy(true);
    const result = await enrollPasskey();
    setBusy(false);
    if (result.ok) {
      toast('Passkey saved — you can use it to sign in', 'success');
      setVisible(false);
    } else if (result.error) {
      toast(result.error, 'error');
    }
  }

  if (!visible) return null;

  return (
    <div className="card-base" style={{ padding: 14, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <KeyRound size={16} style={{ marginTop: 2, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Sign in without the email</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2, lineHeight: 1.5 }}>
            Set up a passkey to use your fingerprint, face or device PIN instead
            of waiting for a code.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => void handleAdd()}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : 'Set up a passkey'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={dismiss}>
              Not now
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="btn btn-ghost btn-sm"
          aria-label="Dismiss"
          style={{ flexShrink: 0 }}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

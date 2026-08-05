'use client';

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, Trash2 } from 'lucide-react';
import { useToast } from '@/components/toast-provider';
import { enrollPasskey, supportsPasskeys } from '@/lib/passkey-client';
import { listPasskeys, deletePasskey, type PasskeySummary } from '@/lib/actions/passkeys';

function formatDate(value: string | null): string {
  if (!value) return 'never';
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function PasskeyManager() {
  const [passkeys, setPasskeys] = useState<PasskeySummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    const res = await listPasskeys();
    setPasskeys(res.ok ? res.data : []);
  }, []);

  useEffect(() => {
    setSupported(supportsPasskeys());
    void refresh();
  }, [refresh]);

  async function handleAdd() {
    setBusy(true);
    const result = await enrollPasskey();
    setBusy(false);
    if (result.ok) {
      toast('Passkey added', 'success');
      await refresh();
    } else if (result.error) {
      toast(result.error, 'error');
    }
  }

  async function handleDelete(id: string) {
    setBusy(true);
    const res = await deletePasskey(id);
    setBusy(false);
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    toast('Passkey removed', 'success');
    await refresh();
  }

  if (!supported) {
    return (
      <div className="settings-row">
        <div className="settings-row-label">Passkeys</div>
        <div className="settings-row-control muted" style={{ fontSize: 12 }}>
          Not supported on this device
        </div>
      </div>
    );
  }

  return (
    <>
      {(passkeys ?? []).map((pk) => (
        <div className="settings-row" key={pk.id}>
          <div className="settings-row-label">
            {pk.nickname || pk.device_type || 'Passkey'}
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
              Added {formatDate(pk.created_at)} · last used {formatDate(pk.last_used_at)}
            </div>
          </div>
          <div className="settings-row-control">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => void handleDelete(pk.id)}
              aria-label="Remove passkey"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}

      {passkeys !== null && passkeys.length === 0 && (
        <div className="settings-row">
          <div className="settings-row-label muted" style={{ fontSize: 12 }}>
            No passkeys yet. Add one to sign in without waiting for an email.
          </div>
        </div>
      )}

      <div className="settings-row">
        <div className="settings-row-label">Add a passkey</div>
        <div className="settings-row-control">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => void handleAdd()}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
            <span style={{ marginLeft: 6 }}>Add</span>
          </button>
        </div>
      </div>
    </>
  );
}

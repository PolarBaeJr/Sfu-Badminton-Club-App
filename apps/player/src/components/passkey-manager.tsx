'use client';

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, Trash2 } from 'lucide-react';
import { useToast } from '@/components/toast-provider';
import { enrollPasskey, supportsPasskeys } from '@/lib/passkey-client';
import { listPasskeys, deletePasskey, passkeysConfigured, type PasskeySummary } from '@/lib/actions/passkeys';

function formatDate(value: string | null): string {
  if (!value) return 'never';
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Where a credential was enrolled (00051). Both belong to the member and both
// are listed; the label exists so this page and the admin console visibly agree
// about the same row rather than each showing a different subset.
const ORIGIN_LABEL: Record<string, string> = {
  admin: 'Enrolled in the admin console',
  player: 'Enrolled in this app',
};

export function PasskeyManager() {
  const [passkeys, setPasskeys] = useState<PasskeySummary[] | null>(null);
  // "Could not load" is a THIRD state, distinct from "loading" and "none". It
  // used to collapse into the empty list, so any failure — a suspended account,
  // a query error — was reported to the member as the flat assertion "No
  // passkeys yet", contradicting the admin console for the same credential.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(false);
  // null while unknown, so the Add row is not flashed and then withdrawn on a
  // deployment where enrolment is switched off.
  const [configured, setConfigured] = useState<boolean | null>(null);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    const res = await listPasskeys();
    if (res.ok) {
      setPasskeys(res.data);
      setLoadError(null);
    } else {
      setPasskeys(null);
      setLoadError(res.error);
    }
  }, []);

  useEffect(() => {
    setSupported(supportsPasskeys());
    void refresh();
    void passkeysConfigured().then(setConfigured);
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
              {ORIGIN_LABEL[pk.enrolled_via] ? ` · ${ORIGIN_LABEL[pk.enrolled_via]}` : ''}
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

      {loadError && (
        <div className="settings-row">
          <div className="settings-row-label muted" style={{ fontSize: 12 }}>
            Could not load your passkeys: {loadError}
          </div>
        </div>
      )}

      {passkeys !== null && passkeys.length === 0 && (
        <div className="settings-row">
          <div className="settings-row-label muted" style={{ fontSize: 12 }}>
            No passkeys yet. Add one to sign in without waiting for an email.
          </div>
        </div>
      )}

      {/* The button appears only where pressing it can work. Enrolment needs a
          server secret this deployment may not have, and offering it anyway
          turned a missing setting into "Passkeys are not configured" shouted at
          a member who did nothing wrong. Existing credentials stay listed and
          revocable either way — that is account security, not a feature flag. */}
      {configured === false ? (
        <div className="settings-row">
          <div className="settings-row-label muted" style={{ fontSize: 12 }}>
            Adding a passkey is unavailable on this server. Your existing passkeys still work.
          </div>
        </div>
      ) : configured === true ? (
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
      ) : null}
    </>
  );
}

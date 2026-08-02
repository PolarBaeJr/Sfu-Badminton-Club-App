'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startRegistration } from '@simplewebauthn/browser';
import { Button, Input, useConfirm } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { removePasskey } from './actions';
import { friendlyPasskeyError } from '@/lib/passkey/errors';

interface Passkey {
  id: string;
  nickname: string | null;
  created_at: string;
  last_used_at: string | null;
  transports: string[] | null;
}

function formatDate(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function PasskeySection({ passkeys }: { passkeys: Passkey[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [nickname, setNickname] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function handleAdd() {
    setAdding(true);
    try {
      // NOTE: fetch() ignores Next's basePath — the /admin prefix must be explicit.
      const optRes = await fetch('/admin/api/passkey/register/options', { method: 'POST' });
      if (!optRes.ok) {
        const body = await optRes.json().catch(() => null);
        throw new Error(body?.error || 'Could not start passkey enrollment');
      }
      const optionsJSON = await optRes.json();

      const attestation = await startRegistration({ optionsJSON });

      const verifyRes = await fetch('/admin/api/passkey/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credential: attestation,
          nickname: nickname.trim() || undefined,
        }),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => null);
        throw new Error(body?.error || 'Passkey enrollment failed');
      }

      toast('Passkey added', 'success');
      setNickname('');
      router.refresh();
    } catch (err) {
      toast(friendlyPasskeyError(err, 'Passkey enrollment failed'), 'error');
    }
    setAdding(false);
  }

  async function handleRemove(id: string) {
    if (!(await confirm({ title: 'Remove passkey?', message: 'Remove this passkey?', confirmLabel: 'Remove', danger: true }))) return;
    setRemovingId(id);
    try {
      await removePasskey(id);
      toast('Passkey removed', 'success');
      router.refresh();
    } catch (err) {
      toast(friendlyPasskeyError(err, 'Failed to remove passkey'), 'error');
    }
    setRemovingId(null);
  }

  return (
    <div>
      {passkeys.map((pk, i) => (
        <div key={pk.id} className="settings-row">
          <div>
            <div className="settings-row-label">{pk.nickname || `Passkey ${i + 1}`}</div>
            <div className="settings-row-hint font-mono text-xs">
              added {formatDate(pk.created_at)} · last used {formatDate(pk.last_used_at)}
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleRemove(pk.id)}
              loading={removingId === pk.id}
            >
              Remove
            </Button>
          </div>
        </div>
      ))}

      <div className="settings-row">
        <div>
          <div className="settings-row-label">Add passkey</div>
          <div className="settings-row-hint">
            {passkeys.length === 0
              ? 'No passkeys enrolled yet — the console is in the grace period. Enrolling one turns the gate on.'
              : 'Adding another passkey requires having logged in with an existing passkey.'}
          </div>
        </div>
        <div className="settings-row-control flex items-center gap-3">
          <Input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="Nickname (optional)"
            maxLength={64}
            className="w-48"
          />
          <Button onClick={handleAdd} loading={adding}>
            Add passkey
          </Button>
        </div>
      </div>
    </div>
  );
}

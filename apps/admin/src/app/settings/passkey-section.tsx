'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startRegistration } from '@simplewebauthn/browser';
import { Button, Input, useConfirm } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { removePasskey } from './actions';
import { friendlyPasskeyError } from '@/lib/passkey/errors';
import { withBase } from '@/lib/base-path';

interface Passkey {
  id: string;
  nickname: string | null;
  created_at: string;
  last_used_at: string | null;
  transports: string[] | null;
  enrolled_via: 'admin' | 'player';
}

// Every credential the member owns is listed on both this page and the members'
// app; this only says where it came from. Only the admin-enrolled ones arm the
// console gate (00051), which is why the two are labelled differently.
const ORIGIN_LABEL: Record<string, string> = {
  admin: 'enrolled here',
  player: 'enrolled in the members’ app',
};

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
  const armsTheGate = passkeys.filter((pk) => pk.enrolled_via === 'admin').length;

  async function handleAdd() {
    setAdding(true);
    try {
      // withBase, not a bare path: fetch() does not apply Next's basePath, so
      // on the path-mounted console this would hit the player app instead.
      const optRes = await fetch(withBase('/api/passkey/register/options'), { method: 'POST' });
      if (!optRes.ok) {
        const body = await optRes.json().catch(() => null);
        throw new Error(body?.error || 'Could not start passkey enrollment');
      }
      const optionsJSON = await optRes.json();

      const attestation = await startRegistration({ optionsJSON });

      const verifyRes = await fetch(withBase('/api/passkey/register/verify'), {
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
              {ORIGIN_LABEL[pk.enrolled_via] ? ` · ${ORIGIN_LABEL[pk.enrolled_via]}` : ''}
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
            {/* Counts only admin-enrolled credentials. Since 00051 a passkey
                added in the members' app does NOT arm the gate, so testing
                `passkeys.length` told an exec the console was gated when it was
                still in the grace period. */}
            {armsTheGate === 0
              ? 'No passkeys enrolled here yet — the console is in the grace period. Enrolling one turns the gate on.'
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

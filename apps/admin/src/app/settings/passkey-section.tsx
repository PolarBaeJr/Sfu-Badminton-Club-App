'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useConfirm } from '@badminton/ui';
import { KeyRound } from 'lucide-react';
import { useToast } from '@/components/toast-provider';
import { removePasskey } from './actions';
import { friendlyPasskeyError } from '@/lib/passkey/errors';
import { graceDaysText } from '@/lib/passkey/grace';
import { AddConsolePasskey } from './add-console-passkey';

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

export function PasskeySection({
  passkeys,
  graceDaysLeft,
}: {
  passkeys: Passkey[];
  // Days left in the 14-day window without a console passkey (00262), or
  // null when that could not be read.
  graceDaysLeft: number | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const armsTheGate = passkeys.filter((pk) => pk.enrolled_via === 'admin').length;

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
        <div key={pk.id} className="flex items-center gap-4 border-b border-[var(--line)] px-6 py-4">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[8px] border border-[var(--line)] bg-[var(--bg-primary)] text-[var(--ink-2)]">
            <KeyRound className="h-4 w-4" />
          </div>
          <div className="flex min-w-0 flex-grow flex-col gap-0.5">
            <span className="truncate text-[15px] font-semibold text-[var(--ink)]">
              {pk.nickname || `Passkey ${i + 1}`}
            </span>
            <span className="font-mono text-xs text-[var(--mute)]">
              added {formatDate(pk.created_at)} · last used {formatDate(pk.last_used_at)}
              {ORIGIN_LABEL[pk.enrolled_via] ? ` · ${ORIGIN_LABEL[pk.enrolled_via]}` : ''}
            </span>
          </div>
          <button
            type="button"
            onClick={() => handleRemove(pk.id)}
            disabled={removingId === pk.id}
            className="inline-flex min-h-[36px] flex-shrink-0 items-center justify-center rounded-[8px] border border-[var(--line)] px-3 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--ink-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)] disabled:opacity-50"
          >
            {removingId === pk.id ? 'Removing' : 'Remove'}
          </button>
        </div>
      ))}

      <div className="px-6 py-5">
        <AddConsolePasskey onAdded={() => router.refresh()} />
        <p className="mt-3 text-[13px] text-[var(--mute)]">
          {/* Counts only admin-enrolled credentials. Since 00051 a passkey
              added in the members' app does NOT arm the gate, so testing
              `passkeys.length` told an exec the console was gated when it was
              still open without one. Without one, the console opens for 14
              days from the first visit (00262). */}
          {armsTheGate > 0
            ? 'Adding another passkey requires having logged in with an existing passkey.'
            : graceDaysLeft === null
              ? 'No passkeys added here yet. The console will ask for one soon.'
              : `No passkeys added here yet. The console opens without one for ${graceDaysText(graceDaysLeft)} more, then asks for one.`}
        </p>
      </div>
    </div>
  );
}

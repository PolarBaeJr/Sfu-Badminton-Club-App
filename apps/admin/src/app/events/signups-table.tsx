'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, useConfirm } from '@badminton/ui';
import { formatDateTime } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { removeClubEventSignup } from '@/lib/actions/club-events';

export interface ClubEventSignupRow {
  player_id: string;
  name: string;
  created_at: string;
}

export function ClubEventSignupsTable({
  eventId,
  rows,
  canRemove,
}: {
  eventId: string;
  rows: ClubEventSignupRow[];
  canRemove: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [removing, setRemoving] = useState<string | null>(null);

  async function handleRemove(row: ClubEventSignupRow) {
    const ok = await confirm({
      title: 'Remove this member?',
      message: `${row.name} is taken off the list. They are not notified.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setRemoving(row.player_id);
    try {
      const result = await removeClubEventSignup(eventId, row.player_id);
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      toast(`${row.name} removed`, 'success');
      router.refresh();
    } finally {
      setRemoving(null);
    }
  }

  if (rows.length === 0) {
    return <p className="px-5 pb-5 text-sm text-[var(--mute)]">Nobody has signed up yet.</p>;
  }
  return (
    <ul className="divide-y divide-[var(--line)]">
      {rows.map((row) => (
        <li key={row.player_id} className="flex items-center justify-between gap-3 px-5 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm text-[var(--ink)]">{row.name}</div>
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--mute)]">
              Signed up {formatDateTime(row.created_at)}
            </div>
          </div>
          {canRemove && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleRemove(row)}
              loading={removing === row.player_id}
            >
              Remove
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

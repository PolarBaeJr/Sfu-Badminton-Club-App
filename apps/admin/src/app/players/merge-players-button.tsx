'use client';

import { useState } from 'react';
import { Button, Dialog, PlayerPicker } from '@badminton/ui';
import { previewPlayerMerge, mergePlayers, type MergePreviewRow } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { Merge, ArrowRight, AlertTriangle } from 'lucide-react';

interface MergeCandidate {
  id: string;
  full_name: string;
  handle: string | null;
  email: string;
  avatar_url?: string | null;
  has_login: boolean;
  status: string;
}

interface Props {
  players: MergeCandidate[];
}

/**
 * Merges a duplicate account into a surviving one. Two rows can never share a
 * UUID, so the survivor keeps its id and everything is repointed onto it.
 *
 * The survivor's own fields always win — whatever the admin entered on the
 * roster record (name, email, status) is preserved; only the login is adopted
 * from the account being removed. Deliberately preview-then-confirm: the
 * removal is irreversible, so the admin sees what blocks it first.
 */
export function MergePlayersButton({ players }: Props) {
  const [open, setOpen] = useState(false);
  const [keepId, setKeepId] = useState('');
  const [removeId, setRemoveId] = useState('');
  const [blockers, setBlockers] = useState<MergePreviewRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [merging, setMerging] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  const keep = players.find((p) => p.id === keepId);
  const remove = players.find((p) => p.id === removeId);
  const bothChosen = Boolean(keepId && removeId && keepId !== removeId);
  const bothHaveLogin = Boolean(keep?.has_login && remove?.has_login);

  function reset() {
    setKeepId(''); setRemoveId(''); setBlockers(null);
  }

  async function handleCheck() {
    setChecking(true);
    setBlockers(null);
    const res = await previewPlayerMerge(keepId, removeId);
    if (!res.ok) { toast(res.error, 'error'); setChecking(false); return; }
    setBlockers(res.data);
    setChecking(false);
  }

  async function handleMerge() {
    setMerging(true);
    const res = await mergePlayers(keepId, removeId);
    if (!res.ok) { toast(res.error, 'error'); setMerging(false); return; }
    toast(res.data.login_moved ? 'Accounts merged — login moved to the kept account' : 'Accounts merged', 'success');
    setMerging(false);
    setOpen(false);
    reset();
    router.refresh();
  }

  // The email/login line is the whole point here — two duplicates share a name,
  // so it is the only thing that tells the admin which record is which.
  const options = players.map((p) => ({
    id: p.id,
    name: p.full_name,
    handle: p.handle,
    avatarUrl: p.avatar_url,
    meta: `${p.email} · ${p.has_login ? 'has login' : 'no login'}`,
  }));

  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <Merge className="w-4 h-4 mr-1.5" /> Merge duplicates
      </Button>

      <Dialog open={open} onClose={() => { if (!merging) { setOpen(false); reset(); } }} title="Merge duplicate accounts">
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Use this when the same person has two records — typically one added to the roster by an
            admin and one they created by signing up. The kept account keeps its own name, email and
            status; only the login is carried over.
          </p>

          <PlayerPicker
            label="Keep this account (admin-entered record)"
            players={options}
            value={keepId}
            onChange={(id) => { setKeepId(id); setBlockers(null); }}
          />
          <PlayerPicker
            label="Remove this account (will be deleted)"
            players={options}
            value={removeId}
            onChange={(id) => { setRemoveId(id); setBlockers(null); }}
          />

          {keep && remove && keepId === removeId && (
            <p className="text-sm text-[var(--color-danger)]">Pick two different accounts.</p>
          )}

          {bothChosen && (
            <div className="flex items-center gap-2 text-sm p-3 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)]">
              <span className="text-[var(--text-primary)]">{remove?.full_name}</span>
              <ArrowRight className="w-4 h-4 text-[var(--text-muted)]" />
              <span className="font-medium text-[var(--text-primary)]">{keep?.full_name}</span>
            </div>
          )}

          {bothHaveLogin && (
            <div className="flex gap-2 p-3 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 text-sm">
              <AlertTriangle className="w-4 h-4 shrink-0 text-[var(--color-danger)] mt-0.5" />
              <span className="text-[var(--text-secondary)]">
                Both accounts have a login. Delete one of the auth users first — otherwise the
                leftover login would create a third account at next sign-in.
              </span>
            </div>
          )}

          {blockers !== null && blockers.length > 0 && (
            <div className="p-3 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 text-sm space-y-1">
              <div className="flex items-center gap-2 text-[var(--color-danger)] font-medium">
                <AlertTriangle className="w-4 h-4" /> Can&apos;t merge — the removed account has history
              </div>
              <ul className="text-[var(--text-secondary)] list-disc pl-5">
                {blockers.map((b) => (
                  <li key={b.table_name}>{b.table_name}: {b.row_count}</li>
                ))}
              </ul>
              <p className="text-[var(--text-muted)]">Try merging the other direction.</p>
            </div>
          )}

          {blockers !== null && blockers.length === 0 && (
            <p className="text-sm text-[var(--color-success)]">
              Safe to merge — the account being removed has no history.
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => { setOpen(false); reset(); }} disabled={merging}>
              Cancel
            </Button>
            {blockers === null || blockers.length > 0 ? (
              <Button onClick={handleCheck} disabled={!bothChosen || checking || bothHaveLogin}>
                {checking ? 'Checking…' : 'Check'}
              </Button>
            ) : (
              <Button variant="danger" onClick={handleMerge} disabled={merging}>
                {merging ? 'Merging…' : 'Merge accounts'}
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}

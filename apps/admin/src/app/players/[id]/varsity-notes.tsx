'use client';

import { useState, useTransition } from 'react';
import { Button, Textarea, useConfirm } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { createVarsityNote, deleteVarsityNote } from '@/lib/actions';
import { formatDateTime } from '@badminton/shared';

interface VarsityNote {
  id: string;
  note: string;
  created_at: string;
  author: { full_name: string } | null;
}

export function VarsityNotes({ playerId, notes }: { playerId: string; notes: VarsityNote[] }) {
  const [note, setNote] = useState('');
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  function handleAdd() {
    startTransition(async () => {
      try {
        await createVarsityNote({ player_id: playerId, note: note.trim() });
        toast('Note added', 'success');
        setNote('');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to add note', 'error');
      }
    });
  }

  async function handleDelete(n: VarsityNote) {
    // Show the note itself, who wrote it and when. These are permanent
    // coaching records and the list can be long — "Delete this note?" beside a
    // row you may have mis-clicked gives the person no way to tell whether they
    // are about to destroy the right one.
    const confirmed = await confirm({
      title: 'Delete note?',
      message: (
        <div className="space-y-2">
          <p>This cannot be undone.</p>
          <div className="rounded-lg border border-[var(--border)] p-3 space-y-1">
            <p className="whitespace-pre-wrap text-[var(--text-primary)]">{n.note}</p>
            <p className="text-xs text-[var(--text-muted)]">
              {n.author?.full_name ?? 'Unknown author'} · {formatDateTime(n.created_at)}
            </p>
          </div>
        </div>
      ),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    const noteId = n.id;
    startTransition(async () => {
      try {
        await deleteVarsityNote(noteId);
        toast('Note deleted', 'success');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to delete note', 'error');
      }
    });
  }

  return (
    <div className="space-y-3">
      {notes.map((n) => (
        // Square hairline, matching the rest of the detail screen. The note
        // itself is prose, so it is the one thing here NOT set in mono; the
        // byline underneath is, because it is a date.
        <div key={n.id} className="border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
          <p className="whitespace-pre-wrap text-sm text-[var(--text-secondary)]">{n.note}</p>
          <div className="flex items-center justify-between gap-3 mt-2">
            <p className="font-mono text-[11px] text-[var(--text-muted)]">
              {n.author?.full_name} &middot; {new Date(n.created_at).toLocaleDateString()}
            </p>
            <button
              onClick={() => handleDelete(n)}
              disabled={isPending}
              className="text-xs text-[var(--color-danger)] hover:underline disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        </div>
      ))}
      {notes.length === 0 && (
        <p className="text-sm text-[var(--text-muted)]">No notes</p>
      )}
      <div className="space-y-2 pt-2 border-t border-[var(--border)]">
        <Textarea
          label="Add a note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Coaching / varsity observations..."
          maxLength={2000}
        />
        <Button size="sm" onClick={handleAdd} loading={isPending} disabled={note.trim().length < 2}>
          Add Note
        </Button>
      </div>
    </div>
  );
}

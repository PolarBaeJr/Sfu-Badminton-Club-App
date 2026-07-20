'use client';

import { useState, useTransition } from 'react';
import { Button, Textarea } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { createVarsityNote, deleteVarsityNote } from '@/lib/actions';

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

  function handleDelete(noteId: string) {
    if (!confirm('Delete this note? This cannot be undone.')) return;
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
        <div key={n.id} className="p-3 bg-[var(--bg-elevated)] rounded-lg border border-[var(--border)]">
          <p className="text-sm text-[var(--text-secondary)]">{n.note}</p>
          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-[var(--text-muted)]">
              {n.author?.full_name} &middot; {new Date(n.created_at).toLocaleDateString()}
            </p>
            <button
              onClick={() => handleDelete(n.id)}
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

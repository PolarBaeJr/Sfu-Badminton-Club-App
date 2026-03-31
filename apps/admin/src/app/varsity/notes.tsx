'use client';

import { useState } from 'react';
import { Button, Dialog, Textarea } from '@badminton/ui';
import { createVarsityNote, deleteVarsityNote } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { formatRelativeTime } from '@badminton/shared';

type Note = {
  id: string;
  note: string;
  created_at: string;
  author: { full_name: string } | null;
};

export function VarsityNoteButton({ playerId, playerName, notes }: { playerId: string; playerName: string; notes: Note[] }) {
  const [open, setOpen] = useState(false);
  const [newNote, setNewNote] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleAdd() {
    if (!newNote.trim()) { toast('Note cannot be empty', 'error'); return; }
    setLoading(true);
    try {
      await createVarsityNote(playerId, newNote);
      toast('Note added', 'success');
      setNewNote('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handleDelete(noteId: string) {
    try {
      await deleteVarsityNote(noteId);
      toast('Note deleted', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Notes ({notes.length})
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Notes - ${playerName}`}>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto">
          {notes.length > 0 ? (
            <div className="space-y-3">
              {notes.map((n) => (
                <div key={n.id} className="border border-[var(--border)] rounded-lg p-3">
                  <p className="text-sm text-[var(--text-primary)]">{n.note}</p>
                  <div className="flex items-center justify-between mt-2">
                    <p className="text-xs text-[var(--text-muted)]">
                      {n.author?.full_name} &middot; {formatRelativeTime(n.created_at)}
                    </p>
                    <Button size="sm" variant="ghost" onClick={() => handleDelete(n.id)}>Delete</Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">No notes yet.</p>
          )}

          <div className="border-t border-[var(--border)] pt-4 space-y-3">
            <Textarea
              label="Add Note"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              rows={3}
            />
            <Button onClick={handleAdd} loading={loading} size="sm">Add Note</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

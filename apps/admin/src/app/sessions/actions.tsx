'use client';

import { useState, useRef, useEffect } from 'react';
import { Button, Dialog, Input } from '@badminton/ui';
import { createSession, updateSession, archiveSession, deleteSession } from '@/lib/actions/session-actions';
import { useToast } from '@/components/toast-provider';
import { MoreVertical, Users } from 'lucide-react';

// ---------------------------------------------------------------------------
// AttendanceDialog
// ---------------------------------------------------------------------------

interface Attendee {
  player_id: string;
  full_name: string;
  checked_in_at: string;
}

interface AttendanceDialogProps {
  sessionId: string;
  attendees: Attendee[];
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function AttendanceDialog({ sessionId: _sessionId, attendees }: AttendanceDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 text-xs text-[var(--ds-accent)] hover:underline"
      >
        <Users className="w-3.5 h-3.5" />
        <span>{attendees.length} checked in</span>
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Attendance">
        {attendees.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)] py-4 text-center">No check-ins yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {attendees.map((a) => (
              <li key={a.player_id} className="flex items-center justify-between py-2.5">
                <span className="text-sm text-[var(--text-primary)]">{a.full_name}</span>
                <span className="text-xs text-[var(--text-muted)]">{relativeTime(a.checked_in_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}

export function CreateSessionForm() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [capacity, setCapacity] = useState('20');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [featured, setFeatured] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const capNum = parseInt(capacity, 10);
      await createSession({
        name,
        date,
        time: time || undefined,
        location,
        notes: notes || undefined,
        capacity: Number.isFinite(capNum) && capNum > 0 ? capNum : undefined,
        start_time: startTime || undefined,
        end_time: endTime || undefined,
        featured,
      });
      toast('Session created', 'success');
      setOpen(false);
      setName(''); setDate(''); setTime(''); setLocation(''); setNotes('');
      setCapacity('20'); setStartTime(''); setEndTime(''); setFeatured(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>New Session</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Create Session">
        <form onSubmit={handleCreate} className="space-y-4">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Tuesday Practice" />
          <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          <Input label="Time (optional)" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          <div className="grid grid-cols-3 gap-3">
            <Input label="Start time" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            <Input label="End time" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            <Input label="Capacity" type="number" min={1} max={200} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
          </div>
          <Input label="Location" value={location} onChange={(e) => setLocation(e.target.value)} required placeholder="e.g. SFU Gym A" />
          <Input label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any additional info..." />
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              cursor: 'pointer',
              padding: '8px 0',
            }}
          >
            <input
              type="checkbox"
              checked={featured}
              onChange={(e) => setFeatured(e.target.checked)}
              style={{ width: 16, height: 16, cursor: 'pointer' }}
            />
            <span style={{ fontSize: 13, color: 'var(--ink)' }}>
              Featured — pin this session at the top of /feed and Sessions list
            </span>
          </label>
          <div className="flex gap-2">
            <Button type="submit" loading={loading}>Create</Button>
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

interface SessionCardMenuProps {
  session: {
    id: string;
    name: string | null;
    date: string;
    location: string;
    notes: string | null;
    status: string;
  };
}

export function SessionCardMenu({ session }: SessionCardMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [name, setName] = useState(session.name || '');
  const [date, setDate] = useState(session.date.split('T')[0] ?? '');
  const [time, setTime] = useState(
    session.date.includes('T') ? session.date.split('T')[1]?.slice(0, 5) : ''
  );
  const [location, setLocation] = useState(session.location);
  const [notes, setNotes] = useState(session.notes || '');
  const [loading, setLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await updateSession(session.id, { name, date, time: time || undefined, location, notes: notes || undefined });
      toast('Session updated', 'success');
      setEditOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handleArchive() {
    if (!confirm('Archive this session? It will be marked as closed.')) return;
    setLoading(true);
    try {
      await archiveSession(session.id);
      toast('Session archived', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
    setMenuOpen(false);
  }

  async function handleDelete() {
    if (!confirm('Delete this session? This cannot be undone.')) return;
    setLoading(true);
    try {
      await deleteSession(session.id);
      toast('Session deleted', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
    setMenuOpen(false);
  }

  return (
    <>
      <div ref={menuRef} className="relative">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center justify-center w-8 h-8 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)] transition-colors"
          aria-label="Session options"
        >
          <MoreVertical className="w-4 h-4" />
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-9 z-20 w-36 border border-[var(--border)] bg-[var(--bg-elevated)] shadow-lg shadow-black/10 overflow-hidden">
            <button
              onClick={() => { setEditOpen(true); setMenuOpen(false); }}
              className="w-full px-4 py-2.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--border-hover)] transition-colors"
            >
              Edit
            </button>
            <button
              onClick={handleArchive}
              disabled={loading}
              className="w-full px-4 py-2.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--border-hover)] transition-colors disabled:opacity-50"
            >
              Archive
            </button>
            <button
              onClick={handleDelete}
              disabled={loading}
              className="w-full px-4 py-2.5 text-left text-sm text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 transition-colors disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      <Dialog open={editOpen} onClose={() => setEditOpen(false)} title="Edit Session">
        <form onSubmit={handleUpdate} className="space-y-4">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Tuesday Practice" />
          <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          <Input label="Time (optional)" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          <Input label="Location" value={location} onChange={(e) => setLocation(e.target.value)} required placeholder="e.g. SFU Gym A" />
          <Input label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any additional info..." />
          <div className="flex gap-2">
            <Button type="submit" loading={loading}>Save Changes</Button>
            <Button variant="ghost" onClick={() => setEditOpen(false)} type="button">Cancel</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

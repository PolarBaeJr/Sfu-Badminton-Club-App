'use client';

import { useState, useRef, useEffect } from 'react';
import { Badge, Button, Dialog, Input, Select } from '@badminton/ui';
import { createSession, updateSession, archiveSession, deleteSession, markAttendance, clearAttendanceMark } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { MoreVertical, Users } from 'lucide-react';
import type { SessionGroupInput, AttendanceStatus, AttendanceStatusInput } from '@badminton/shared';

const TRACK_OPTIONS = [
  { value: 'all', label: 'All players' },
  { value: 'competitive', label: 'Competitive' },
  { value: 'recreational', label: 'Recreational' },
];

// ---------------------------------------------------------------------------
// AttendanceDialog
// ---------------------------------------------------------------------------

interface Attendee {
  player_id: string;
  full_name: string;
  checked_in_at: string;
  status: AttendanceStatus;
  marked_by: string | null;
  marked_at: string | null;
}

interface AttendanceDialogProps {
  sessionId: string;
  attendees: Attendee[];
  players: { id: string; full_name: string }[];
}

const ATTENDANCE_BADGES: Record<AttendanceStatus, { label: string; variant: 'success' | 'warning' | 'danger' }> = {
  checked_in: { label: 'Checked In', variant: 'success' },
  present: { label: 'Present', variant: 'success' },
  no_show: { label: 'No-show', variant: 'danger' },
  excused: { label: 'Excused', variant: 'warning' },
};

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

export function AttendanceDialog({ sessionId, attendees, players }: AttendanceDialogProps) {
  const [open, setOpen] = useState(false);
  const [addPlayerId, setAddPlayerId] = useState('');
  const [busyPlayerId, setBusyPlayerId] = useState<string | null>(null);
  const { toast } = useToast();

  const listedIds = new Set(attendees.map((a) => a.player_id));
  const addablePlayers = players.filter((p) => !listedIds.has(p.id));

  async function handleMark(playerId: string, status: AttendanceStatusInput) {
    setBusyPlayerId(playerId);
    try {
      await markAttendance({ session_id: sessionId, player_id: playerId, status });
      toast('Attendance updated', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setBusyPlayerId(null);
  }

  async function handleRemove(playerId: string) {
    if (!confirm('Remove this attendance record?')) return;
    setBusyPlayerId(playerId);
    try {
      await clearAttendanceMark(sessionId, playerId);
      toast('Attendance record removed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setBusyPlayerId(null);
  }

  async function handleAdd() {
    if (!addPlayerId) return;
    await handleMark(addPlayerId, 'present');
    setAddPlayerId('');
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 text-xs text-[var(--color-accent)] hover:underline"
      >
        <Users className="w-3.5 h-3.5" />
        <span>{attendees.length} checked in</span>
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Attendance">
        {attendees.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)] py-4 text-center">No check-ins yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {attendees.map((a) => {
              const badge = ATTENDANCE_BADGES[a.status];
              const busy = busyPlayerId === a.player_id;
              return (
                <li key={a.player_id} className="py-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-[var(--text-primary)]">{a.full_name}</span>
                    <div className="flex items-center gap-2">
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      <span className="text-xs text-[var(--text-muted)]">{relativeTime(a.checked_in_at)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Button size="sm" variant="ghost" disabled={busy || a.status === 'present'} onClick={() => handleMark(a.player_id, 'present')}>
                      Present
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy || a.status === 'no_show'} onClick={() => handleMark(a.player_id, 'no_show')}>
                      No-show
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy || a.status === 'excused'} onClick={() => handleMark(a.player_id, 'excused')}>
                      Excused
                    </Button>
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => handleRemove(a.player_id)}>
                      Remove
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Walk-ins: mark a player present without a self check-in */}
        {addablePlayers.length > 0 && (
          <div className="flex items-end gap-2 pt-4 mt-2 border-t border-[var(--border)]">
            <div className="flex-1">
              <Select
                label="Add player"
                options={[{ value: '', label: 'Select a player...' }, ...addablePlayers.map((p) => ({ value: p.id, label: p.full_name }))]}
                value={addPlayerId}
                onChange={(e) => setAddPlayerId(e.target.value)}
              />
            </div>
            <Button disabled={!addPlayerId || busyPlayerId !== null} onClick={handleAdd}>
              Mark present
            </Button>
          </div>
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
  const [endTime, setEndTime] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [track, setTrack] = useState<SessionGroupInput>('all');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await createSession({ name, date, time: time || undefined, end_time: endTime || undefined, location, notes: notes || undefined, track });
      toast('Session created', 'success');
      setOpen(false);
      setName(''); setDate(''); setTime(''); setEndTime(''); setLocation(''); setNotes(''); setTrack('all');
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
          <Input label="End time (optional)" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          <Input label="Location" value={location} onChange={(e) => setLocation(e.target.value)} required placeholder="e.g. SFU Gym A" />
          <Select label="Track" options={TRACK_OPTIONS} value={track} onChange={(e) => setTrack(e.target.value as SessionGroupInput)} />
          <Input label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any additional info..." />
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
    start_time: string | null;
    end_time: string | null;
    location: string;
    notes: string | null;
    status: string;
    track: SessionGroupInput;
  };
}

export function SessionCardMenu({ session }: SessionCardMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [name, setName] = useState(session.name || '');
  const [date, setDate] = useState(session.date.split('T')[0] ?? '');
  const [time, setTime] = useState(session.start_time?.slice(0, 5) ?? '');
  const [endTime, setEndTime] = useState(session.end_time?.slice(0, 5) ?? '');
  const [location, setLocation] = useState(session.location);
  const [notes, setNotes] = useState(session.notes || '');
  const [track, setTrack] = useState<SessionGroupInput>(session.track);
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
      await updateSession(session.id, { name, date, time: time || undefined, end_time: endTime || undefined, location, notes: notes || undefined, track });
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
          className="flex items-center justify-center w-8 h-8 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)] transition-colors"
          aria-label="Session options"
        >
          <MoreVertical className="w-4 h-4" />
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-9 z-20 w-36 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] shadow-lg shadow-black/10 overflow-hidden">
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
          <Input label="End time (optional)" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          <Input label="Location" value={location} onChange={(e) => setLocation(e.target.value)} required placeholder="e.g. SFU Gym A" />
          <Select label="Track" options={TRACK_OPTIONS} value={track} onChange={(e) => setTrack(e.target.value as SessionGroupInput)} />
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

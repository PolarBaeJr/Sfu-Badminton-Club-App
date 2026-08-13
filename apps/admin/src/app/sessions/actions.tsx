'use client';

import { useState, useRef, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Dialog, Input, PlayerPicker, Select, Textarea, useConfirm, DatePicker } from '@badminton/ui';
import { createSession, updateSession, archiveSession, deleteSession, markAttendance, clearAttendanceMark, sendSessionReminders, getOrCreateSessionCheckinToken, rotateSessionCheckinToken } from '@/lib/actions';
import { runBulk, summarizeBulk } from '@/lib/bulk-add';
import { useToast } from '@/components/toast-provider';
import { LocationField } from './location-field';
import { useLiveAttendance } from './live-attendance';
import { MoreVertical, Users, QrCode } from 'lucide-react';
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
  /** The walk-in roster. EMPTY when the viewer may not mark attendance — the
   *  page skips that fetch entirely rather than sending a list nothing draws. */
  players: { id: string; full_name: string; avatar_url?: string | null }[];
  /** `sessions.attendance.write`. Every control inside the dialog is this one
   *  capability; the LIST is not, because reading who turned up is what the
   *  section is for. */
  canWrite: boolean;
  /** How the row-action button is drawn. Tonight's door list is the thing an
   *  officer is reaching for, so it gets the solid treatment and every other
   *  row gets the quiet one. */
  variant?: 'secondary' | 'ghost';
  label?: string;
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

export function AttendanceDialog({
  sessionId,
  attendees,
  players,
  canWrite,
  variant = 'ghost',
  label = 'Door list',
}: AttendanceDialogProps) {
  const [open, setOpen] = useState(false);
  const [addPlayerIds, setAddPlayerIds] = useState<string[]>([]);
  // Separate from busyPlayerId: that one names the single row whose buttons are
  // spinning, and a walk-in batch is not any one row.
  const [addingWalkIns, setAddingWalkIns] = useState(false);
  const [busyPlayerId, setBusyPlayerId] = useState<string | null>(null);
  const { toast } = useToast();
  const confirm = useConfirm();

  // WHILE IT IS OPEN, AND ONLY THIS SESSION. `attendees` is a server prop, so
  // a refresh re-runs page.tsx and this list re-renders underneath a dialog
  // that stays open — the point being somebody ELSE's check-in, which
  // revalidatePath on our own writes can never deliver. Closed, the effect
  // tears the channel down, so the twenty door lists an officer opens across a
  // club night are never twenty live sockets. Named per session for the same
  // reason: one of these is mounted for every row on the page.
  useLiveAttendance({
    channel: `door-list-${sessionId}`,
    sessionIds: [sessionId],
    enabled: open,
  });

  const listedIds = new Set(attendees.map((a) => a.player_id));
  const addablePlayers = players.filter((p) => !listedIds.has(p.id));

  async function handleMark(playerId: string, status: AttendanceStatusInput) {
    setBusyPlayerId(playerId);
    try {
      const res = await markAttendance({ session_id: sessionId, player_id: playerId, status });
      if (!res.ok) { toast(res.error, 'error'); setBusyPlayerId(null); return; }
      toast('Attendance updated', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setBusyPlayerId(null);
  }

  async function handleRemove(playerId: string) {
    if (!(await confirm({ title: 'Remove attendance?', message: 'Remove this attendance record?', confirmLabel: 'Remove', danger: true }))) return;
    setBusyPlayerId(playerId);
    try {
      const res = await clearAttendanceMark(sessionId, playerId);
      if (!res.ok) { toast(res.error, 'error'); setBusyPlayerId(null); return; }
      toast('Attendance record removed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setBusyPlayerId(null);
  }

  async function handleAdd() {
    if (addPlayerIds.length === 0) return;
    setAddingWalkIns(true);
    const outcome = await runBulk(addPlayerIds, async (playerId) => {
      const res = await markAttendance({ session_id: sessionId, player_id: playerId, status: 'present' });
      // markAttendance reports failure by RETURNING { ok: false } rather than
      // throwing. Without this, a rejected mark would be counted as a success
      // and the batch would claim it added people it did not.
      if (!res.ok) throw new Error(res.error);
    });
    const { message, tone } = summarizeBulk(outcome, {
      done: 'Marked', failed: 'Could not mark', noun: 'player present', nounPlural: 'players present',
    });
    toast(message, tone);
    // Keep the ones that failed selected so a partial run is visible, not just
    // stated in a toast that will disappear.
    setAddPlayerIds(outcome.failures.map((f) => f.id));
    setAddingWalkIns(false);
  }

  return (
    <>
      {/* 44px, because this is the button an officer taps one-handed at the
          gym door. Button's `md` stops at 40. */}
      <Button
        variant={variant}
        onClick={() => setOpen(true)}
        className="min-h-[44px] w-full sm:w-auto"
      >
        <Users className="w-3.5 h-3.5" />
        <span>{label}</span>
      </Button>

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
                  {/* The marks are `sessions.attendance.write`, the list above
                      is not. Somebody who may see who turned up but not change
                      it gets the roll and no buttons. */}
                  {canWrite && (
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
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* Walk-ins: mark a player present without a self check-in.
            `canWrite` as well as a non-empty roster, because the roster is only
            fetched for a holder of the write in the first place — the second
            test is belt to that brace, so a future caller that hands the list
            over cannot accidentally hand over the control with it. */}
        {canWrite && addablePlayers.length > 0 && (
          <div className="flex items-end gap-2 pt-4 mt-2 border-t border-[var(--border)]">
            <div className="flex-1">
              <PlayerPicker
                multiple
                label="Add players"
                players={addablePlayers.map((p) => ({ id: p.id, name: p.full_name, avatarUrl: p.avatar_url }))}
                value={addPlayerIds}
                onChange={setAddPlayerIds}
              />
            </div>
            <Button
              loading={addingWalkIns}
              disabled={addPlayerIds.length === 0 || busyPlayerId !== null || addingWalkIns}
              onClick={handleAdd}
            >
              {addPlayerIds.length > 1 ? `Mark ${addPlayerIds.length} present` : 'Mark present'}
            </Button>
          </div>
        )}
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// CheckinQrDialog
// ---------------------------------------------------------------------------

interface CheckinQrDialogProps {
  sessionId: string;
  // Both null until an admin generates the code. The QR is rendered server-side
  // in page.tsx so the qrcode library never reaches the client bundle.
  url: string | null;
  svg: string | null;
}

export function CheckinQrDialog({ sessionId, url, svg }: CheckinQrDialogProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const { toast } = useToast();
  const confirm = useConfirm();
  const router = useRouter();

  async function handleGenerate() {
    setBusy(true);
    try {
      const res = await getOrCreateSessionCheckinToken(sessionId);
      if (!res.ok) { toast(res.error, 'error'); setBusy(false); return; }
      toast('Check-in code ready', 'success');
      startTransition(() => router.refresh());
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setBusy(false);
  }

  async function handleRotate() {
    if (!(await confirm({ title: 'Rotate code?', message: 'Issue a new code? Any QR already printed or shared stops working immediately.', confirmLabel: 'Rotate' }))) return;
    setBusy(true);
    try {
      const res = await rotateSessionCheckinToken(sessionId);
      if (!res.ok) { toast(res.error, 'error'); setBusy(false); return; }
      toast('New check-in code issued', 'success');
      startTransition(() => router.refresh());
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setBusy(false);
  }

  return (
    <>
      <Button
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label="Check-in QR"
        className="min-h-[44px] px-3"
      >
        <QrCode className="w-4 h-4" />
        <span>QR</span>
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Check-in QR">
        {url && svg ? (
          <div className="space-y-4">
            {/* Server-generated from a URL we built ourselves (origin + a hex
                token we minted) — never from user input, so the SVG markup is
                ours and not attacker-controlled. */}
            <div
              className="flex justify-center bg-white rounded-lg p-4"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            <p className="text-sm text-[var(--text-secondary)] text-center">
              Players scan this with their phone camera to check themselves in.
            </p>
            <p className="text-xs font-mono break-all text-[var(--text-muted)] text-center">{url}</p>
            <div className="flex items-center justify-between pt-2 border-t border-[var(--border)]">
              <span className="text-xs text-[var(--text-muted)]">
                Rotating revokes every shared copy of the old code.
              </span>
              <Button variant="ghost" disabled={busy || refreshing} onClick={handleRotate}>
                Rotate code
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-2 text-center">
            <p className="text-sm text-[var(--text-muted)]">
              No check-in code for this session yet.
            </p>
            <Button disabled={busy || refreshing} onClick={handleGenerate}>
              Generate code
            </Button>
          </div>
        )}
      </Dialog>
    </>
  );
}

// Mirrors the server's weekly recurrence in createSession: UTC math on the
// YYYY-MM-DD strings so the preview never drifts across DST. Capped at 41 so a
// typo'd far-future end date can't flood the dialog with chips (the server
// rejects anything over 40 anyway).
function weeklySeriesDates(start: string, until: string): string[] {
  const dates = [start];
  let ms = Date.parse(start);
  while (dates.length <= 40) {
    ms += 7 * 86400000;
    const next = new Date(ms).toISOString().slice(0, 10);
    if (next > until) break;
    dates.push(next);
  }
  return dates;
}

// UTC to match the date-only strings (parsed as UTC midnight) — a local-zone
// format would render the previous day anywhere west of UTC.
const CHIP_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function CreateSessionForm() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [track, setTrack] = useState<SessionGroupInput>('all');
  const [repeatWeekly, setRepeatWeekly] = useState(false);
  const [repeatUntil, setRepeatUntil] = useState('');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const series = repeatWeekly && date && repeatUntil && repeatUntil >= date
    ? weeklySeriesDates(date, repeatUntil)
    : [];
  const excludedInSeries = series.filter((d) => excluded.has(d));

  function toggleExcluded(d: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d); else next.add(d);
      return next;
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await createSession({
        name,
        date,
        time: time || undefined,
        end_time: endTime || undefined,
        location,
        notes: notes || undefined,
        track,
        repeat_until: repeatWeekly && repeatUntil ? repeatUntil : undefined,
        excluded_dates: excludedInSeries.length > 0 ? excludedInSeries : undefined,
      });
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      const { count } = res.data;
      toast(count > 1 ? `Created ${count} sessions` : 'Session created', 'success');
      setOpen(false);
      setName(''); setDate(''); setTime(''); setEndTime(''); setLocation(''); setNotes(''); setTrack('all');
      setRepeatWeekly(false); setRepeatUntil(''); setExcluded(new Set());
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>New session</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Create Session">
        <form onSubmit={handleCreate} className="space-y-4">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Tuesday Practice" />
          <DatePicker label="Date" value={date} onChange={(v) => { setDate(v); setExcluded(new Set()); }} required />
          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={repeatWeekly}
              onChange={(e) => setRepeatWeekly(e.target.checked)}
              className="rounded border-[var(--border)]"
            />
            Repeat weekly
          </label>
          {repeatWeekly && (
            <DatePicker label="Repeat until" value={repeatUntil} min={date || undefined} onChange={(v) => { setRepeatUntil(v); setExcluded(new Set()); }} required />
          )}
          {series.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {series.map((d) => {
                  const off = excluded.has(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => toggleExcluded(d)}
                      aria-pressed={off}
                      className={`px-2 py-1 text-xs border transition-colors ${
                        off
                          ? 'border-[var(--color-danger)]/40 text-[var(--text-muted)] line-through'
                          : 'border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--border-hover)]'
                      }`}
                    >
                      {CHIP_DATE.format(new Date(d))}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-[var(--text-muted)]">
                {series.length - excludedInSeries.length} session{series.length - excludedInSeries.length === 1 ? '' : 's'} will be created
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input label="Start time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            <Input label="End time" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </div>
          <LocationField value={location} onChange={setLocation} />
          <Select label="Track" options={TRACK_OPTIONS} value={track} onChange={(e) => setTrack(e.target.value as SessionGroupInput)} />
          <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any additional info..." />
          <div className="flex items-center justify-between pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
            <Button type="submit" loading={loading}>Create</Button>
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
  /** FOUR CAPABILITIES, NOT ONE FLAG. This menu offered Edit, Send reminder,
   *  Archive and Delete to everybody the section admitted, and each of those is
   *  a separate grant — `sessions.update.write`, `sessions.reminders.write`,
   *  `sessions.archive.write`, `sessions.delete.write`. The server actions have
   *  always re-checked them individually, so the menu was offering three
   *  controls that would bounce to anyone holding only the fourth. */
  can: {
    update: boolean;
    reminders: boolean;
    archive: boolean;
    delete: boolean;
  };
}

export function SessionCardMenu({ session, can }: SessionCardMenuProps) {
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
  // The audited pair. Archiving ends check-in for everyone still walking in and
  // deleting takes the attendance rows with it, so both go through a dialog that
  // names the session and takes a written reason — the console's rule for an
  // audited action, and one useConfirm() cannot express (ConfirmOptions has no
  // reason field, and packages/ui is out of scope here).
  const [reasonFor, setReasonFor] = useState<'archive' | 'delete' | null>(null);
  const [reason, setReason] = useState('');
  // Editing is audited too, so it takes one as well — but in its own form
  // rather than through the dialog above, because the edit already HAS a form
  // and routing it through a second confirmation step would put a dialog in
  // front of a dialog. Separate state so a half-typed archive reason cannot
  // leak into a save.
  const [editReason, setEditReason] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const confirm = useConfirm();

  const sessionLabel = session.name || 'this session';

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
    // Mirrors the server's floor (REASON_MIN in lib/actions/sessions.ts), the
    // same way handleReasonedAction does, so the refusal arrives before the
    // round trip rather than as a thrown error afterwards.
    if (editReason.trim().length < 5) { toast('A reason of at least 5 characters is required', 'error'); return; }
    setLoading(true);
    try {
      const res = await updateSession(session.id, { name, date, time: time || undefined, end_time: endTime || undefined, location, notes: notes || undefined, track }, editReason);
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      toast('Session updated', 'success');
      closeEdit();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  // The reason is cleared on the way out, so reopening Edit does not offer the
  // last edit's sentence as the explanation for this one.
  function closeEdit() {
    setEditOpen(false);
    setEditReason('');
  }

  async function handleSendReminders() {
    if (!(await confirm({ title: 'Send reminders?', message: 'Notify everyone who RSVP’d "going" to this session?', confirmLabel: 'Send' }))) return;
    setLoading(true);
    try {
      const res = await sendSessionReminders(session.id);
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); setMenuOpen(false); return; }
      toast(res.data.notified > 0 ? `Reminder sent to ${res.data.notified} player${res.data.notified === 1 ? '' : 's'}` : 'No one has RSVP’d going yet', res.data.notified > 0 ? 'success' : 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
    setMenuOpen(false);
  }

  function closeReason() {
    setReasonFor(null);
    setReason('');
  }

  async function handleReasonedAction() {
    const which = reasonFor;
    if (!which) return;
    // Mirrors the server's floor (REASON_MIN in lib/actions/sessions.ts) so the
    // refusal arrives before the round trip, not as a thrown error afterwards.
    if (reason.trim().length < 5) { toast('A reason of at least 5 characters is required', 'error'); return; }
    setLoading(true);
    try {
      const res = which === 'archive'
        ? await archiveSession(session.id, reason)
        : await deleteSession(session.id, reason);
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      toast(which === 'archive' ? 'Session archived' : 'Session deleted', 'success');
      closeReason();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  // Nothing to open. A viewer holding the page and none of the four writes gets
  // no menu button at all rather than an empty popover.
  if (!can.update && !can.reminders && !can.archive && !can.delete) return null;

  const ITEM =
    'w-full px-4 py-2.5 text-left text-sm transition-colors disabled:opacity-50 min-h-[44px]';

  return (
    <>
      <div ref={menuRef} className="relative">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center justify-center min-h-[44px] min-w-[44px] rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)] transition-colors"
          aria-label="Session options"
        >
          <MoreVertical className="w-4 h-4" />
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-11 z-20 w-40 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] shadow-lg shadow-black/10 overflow-hidden">
            {can.update && (
              <button
                onClick={() => { setEditOpen(true); setMenuOpen(false); }}
                className={`${ITEM} text-[var(--text-primary)] hover:bg-[var(--border-hover)]`}
              >
                Edit
              </button>
            )}
            {can.reminders && (
              <button
                onClick={handleSendReminders}
                disabled={loading}
                className={`${ITEM} text-[var(--text-primary)] hover:bg-[var(--border-hover)]`}
              >
                Send reminder
              </button>
            )}
            {can.archive && (
              <button
                onClick={() => { setReasonFor('archive'); setMenuOpen(false); }}
                disabled={loading}
                className={`${ITEM} text-[var(--text-primary)] hover:bg-[var(--border-hover)]`}
              >
                Archive
              </button>
            )}
            {can.delete && (
              <button
                onClick={() => { setReasonFor('delete'); setMenuOpen(false); }}
                disabled={loading}
                className={`${ITEM} text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      <Dialog open={editOpen} onClose={closeEdit} title="Edit Session">
        <form onSubmit={handleUpdate} className="space-y-4">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Tuesday Practice" />
          <DatePicker label="Date" value={date} onChange={setDate} required />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Start time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            <Input label="End time" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </div>
          <LocationField value={location} onChange={setLocation} />
          <Select label="Track" options={TRACK_OPTIONS} value={track} onChange={(e) => setTrack(e.target.value as SessionGroupInput)} />
          <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any additional info..." />
          {/* Last, under the fields it explains, and worded so it is clear the
              sentence is about the change rather than about the session. Members
              are told when a session moves; the audit row is where the exec who
              moved it says why. */}
          <Textarea
            label="Reason (required)"
            value={editReason}
            onChange={(e) => setEditReason(e.target.value)}
            placeholder="e.g. Gym double-booked, moved to Court 3"
          />
          <div className="flex items-center justify-between pt-2">
            <Button variant="ghost" onClick={closeEdit} type="button">Cancel</Button>
            <Button type="submit" loading={loading} disabled={editReason.trim().length < 5}>Save Changes</Button>
          </div>
        </form>
      </Dialog>

      {/* The audited pair. The title names the session rather than asking "are
          you sure?", and the confirm button stays disabled until the reason has
          real content in it — a reason nobody wrote is a reason nobody can read
          back. */}
      <Dialog
        open={reasonFor !== null}
        onClose={closeReason}
        title={reasonFor === 'delete' ? `Delete ${sessionLabel}` : `Archive ${sessionLabel}`}
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            {reasonFor === 'delete'
              ? 'This deletes the session and every attendance record on it. It cannot be undone.'
              : 'This closes the session. Nobody can check in to it afterwards.'}
          </p>
          <Textarea label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex items-center justify-between pt-1">
            <Button variant="ghost" type="button" onClick={closeReason}>Cancel</Button>
            <Button
              variant="danger"
              loading={loading}
              disabled={reason.trim().length < 5}
              onClick={handleReasonedAction}
            >
              {reasonFor === 'delete' ? 'Delete session' : 'Archive session'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Dialog, Dropdown, Input, PlayerPicker, Select, Textarea, useConfirm, DatePicker } from '@badminton/ui';
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
  // reason: one of these is mounted for every row on the page — twice over, in
  // fact, because ResponsiveTable renders the card layout and the table layout
  // together and hides one with CSS. Only the visible copy can be clicked, so
  // only one of the pair is ever open, and `enabled` is what keeps the other
  // from opening a second channel on the same name.
  //
  // The dialog survives the refresh because `open` is client state and the
  // element's position is stable: SessionTable keys both layouts on the
  // session id and renders row.actions unconditionally, so React reconciles
  // rather than remounting. A remount here would close the dialog on every
  // check-in — the exact opposite of the feature.
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
        {/* SAY WHY THE BUTTONS ARE MISSING. Without this the dialog opens on a
            read-only roll with no Present / No-show / Excused / Remove and no
            walk-in picker, and nothing anywhere explains it — an officer at the
            door at 19:00 concludes the app is broken and has no idea what to
            ask for. `sessions.attendance.write` is not in EXEC_BASELINE (it is
            twelve reads by the club owner's decision), so an exec nobody has
            assigned a role or a grant to lands here. This turns a silent
            absence into an instruction. */}
        {!canWrite && (
          <p className="text-sm text-[var(--text-muted)] border border-[var(--border)] p-3 mb-3">
            You can see who turned up but not change it. Marking attendance needs
            the <span className="font-mono text-xs">sessions.attendance.write</span>{' '}
            permission — an admin can grant it on the Permissions page.
          </p>
        )}
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
                          ? 'border-[color-mix(in_oklab,var(--color-danger)_40%,transparent)] text-[var(--text-muted)] line-through'
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
    /** Undefined until migration 00116 is applied — the page selects '*', so
     *  the field simply is not there yet. Read through a `=== true` so the
     *  checkbox is never handed an undefined and never flips to uncontrolled. */
    require_scan_to_check_in?: boolean | null;
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
  const [editOpen, setEditOpen] = useState(false);
  const [name, setName] = useState(session.name || '');
  const [date, setDate] = useState(session.date.split('T')[0] ?? '');
  const [time, setTime] = useState(session.start_time?.slice(0, 5) ?? '');
  const [endTime, setEndTime] = useState(session.end_time?.slice(0, 5) ?? '');
  const [location, setLocation] = useState(session.location);
  const [notes, setNotes] = useState(session.notes || '');
  const [track, setTrack] = useState<SessionGroupInput>(session.track);
  const [requireScan, setRequireScan] = useState(session.require_scan_to_check_in === true);
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
  const { toast } = useToast();
  const confirm = useConfirm();

  const sessionLabel = session.name || 'this session';

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    // Mirrors the server's floor (REASON_MIN in lib/actions/sessions.ts), the
    // same way handleReasonedAction does, so the refusal arrives before the
    // round trip rather than as a thrown error afterwards.
    if (editReason.trim().length < 5) { toast('A reason of at least 5 characters is required', 'error'); return; }
    setLoading(true);
    try {
      const res = await updateSession(session.id, { name, date, time: time || undefined, end_time: endTime || undefined, location, notes: notes || undefined, track, require_scan_to_check_in: requireScan }, editReason);
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      toast('Session updated', 'success');
      // NOT closeEdit(): after a successful save the value just submitted IS
      // the persisted one, and closeEdit resets from `session` — a prop
      // captured BEFORE the action ran. React keeps this client state when the
      // revalidated props arrive, so resetting here would leave the checkbox
      // showing the opposite of what the database now holds, and the next
      // unrelated edit would quietly write that stale value back, turning a
      // scan-required night back into an ordinary one with nobody touching the
      // checkbox.
      closeEditKeeping(requireScan);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  // The reason is cleared on the way out, so reopening Edit does not offer the
  // last edit's sentence as the explanation for this one.
  //
  // The scan checkbox is reset with it, which the text fields deliberately are
  // not. Every other field in this dialog keeps whatever was typed after a
  // Cancel, and that is merely untidy — a half-typed location is obviously a
  // draft. A checkbox is not: toggled on, cancelled, and reopened, it would
  // read as a statement that this night IS scan-required when the database says
  // it is not, and an exec has no way to tell the two apart by looking.
  // CANCEL path only — discards the toggle by returning to what the server last
  // told us. Do not call this after a successful save; use closeEditKeeping.
  function closeEdit() {
    closeEditKeeping(session.require_scan_to_check_in === true);
  }

  /** Shut the dialog and leave the checkbox showing `requireScanValue`. */
  function closeEditKeeping(requireScanValue: boolean) {
    setEditOpen(false);
    setEditReason('');
    setRequireScan(requireScanValue);
  }

  async function handleSendReminders() {
    if (!(await confirm({ title: 'Send reminders?', message: 'Notify everyone who RSVP’d "going" to this session?', confirmLabel: 'Send' }))) return;
    setLoading(true);
    try {
      const res = await sendSessionReminders(session.id);
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      toast(res.data.notified > 0 ? `Reminder sent to ${res.data.notified} player${res.data.notified === 1 ? '' : 's'}` : 'No one has RSVP’d going yet', res.data.notified > 0 ? 'success' : 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
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

  // PORTALLED, NOT `absolute`, AND THAT IS THE WHOLE POINT OF THIS COMPONENT
  // CHOICE. This menu is rendered into the last cell of the table in
  // session-table.tsx, and ResponsiveTable puts that table inside
  // `overflow-x-auto` so a wide table can scroll on a laptop. CSS makes
  // `overflow-y` compute to `auto` the moment the other axis is anything but
  // `visible`, so that box clips VERTICALLY as well — and an `absolute` menu
  // hanging off the last (often only) row was sliced off at the card's bottom
  // edge, which is how this was reported. packages/ui's Dropdown renders into
  // document.body and re-measures on scroll, so no ancestor's overflow can
  // reach it. /matches and /tournaments already use it for exactly this row
  // menu; this file was the one place that hand-rolled its own, which is also
  // why it was the one place with the bug.
  //
  // Built as an array rather than four conditional children because Dropdown
  // takes its items as data. An action the caller may not perform is left OUT
  // of the array — same rule as before, where the whole button was omitted —
  // and `disabled` is reserved for "already in flight".
  const items: React.ComponentProps<typeof Dropdown>['items'] = [];
  if (can.update) items.push({ label: 'Edit', onClick: () => setEditOpen(true) });
  // Wrapped rather than passed by reference: handleSendReminders is async and
  // Dropdown's onClick is `() => void`, so the floating promise is discarded
  // explicitly instead of by coercion. It reports through the toast either way.
  if (can.reminders) items.push({ label: 'Send reminder', onClick: () => { void handleSendReminders(); }, disabled: loading });
  if (can.archive) items.push({ label: 'Archive', onClick: () => setReasonFor('archive'), disabled: loading });
  if (can.delete) items.push({ label: 'Delete', onClick: () => setReasonFor('delete'), danger: true, disabled: loading });

  return (
    <>
      <Dropdown
        trigger={
          // No onClick here: Dropdown's own wrapper owns the toggle, and a
          // second handler on the button would fire it twice and close the menu
          // on the same click that opened it.
          <button
            className="flex items-center justify-center min-h-[44px] min-w-[44px] rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)] transition-colors"
            aria-label="Session options"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
        }
        items={items}
      />

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

          {/* THE PRESENCE SWITCH. It lives here, inside Edit, because it is a
              property of this one night and `sessions.update.write` — the
              capability already gating this whole dialog — is exactly the right
              grant for it: whoever may move the night may decide how strictly
              its door is kept.

              Not on the Create form. A night is made strict once somebody has
              decided it should be, which is rarely the moment it is scheduled,
              and putting it there would also stamp the choice across a whole
              40-week weekly series in one click.

              The consequence is spelled out under the label rather than left to
              be discovered on a member's phone at the door: with this on, the
              only way in is the printed QR, and a member who cannot scan has to
              be checked in by an officer from the door list. */}
          <div className="space-y-1.5">
            <label className="flex items-start gap-2 text-sm text-[var(--text-secondary)] min-h-[44px] py-2 cursor-pointer">
              <input
                type="checkbox"
                checked={requireScan}
                onChange={(e) => setRequireScan(e.target.checked)}
                className="mt-0.5 rounded border-[var(--border)]"
              />
              <span>Require scanning the check-in code</span>
            </label>
            <p className="text-xs text-[var(--text-muted)]">
              {requireScan
                ? 'Members must scan the QR on the door. Checking in from the app without it is refused, so anyone whose camera will not work needs an officer to mark them present.'
                : 'Members can scan the QR or check in with one tap from the schedule.'}
            </p>
          </div>

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

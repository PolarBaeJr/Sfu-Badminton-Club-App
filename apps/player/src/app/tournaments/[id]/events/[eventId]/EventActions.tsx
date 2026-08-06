'use client';

import { useState } from 'react';
import { Button, Dialog, LegalMarkdown, useConfirm } from '@badminton/ui';
import { eventHasDraw, isOutOfEvent } from '@badminton/shared';
import { registerForEvent, withdrawFromEvent, selfCheckIn } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useStanding } from '@/components/standing-provider';
import { StandingNote } from '@/components/standing-notice';
import { useRouter } from 'next/navigation';
import { UserPlus, UserMinus, CheckCircle } from 'lucide-react';

interface Props {
  eventId: string;
  eventStatus: string;
  playerRegistration: {
    status: string;
  } | null;
  isDoubles: boolean;
  suspended?: boolean;
  eventWaiverText?: string | null;
}

export function EventActions({ eventId, eventStatus, playerRegistration, isDoubles, suspended, eventWaiverText }: Props) {
  const [loading, setLoading] = useState(false);
  const [waiverOpen, setWaiverOpen] = useState(false);
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();
  // `suspended` above is the TOURNAMENT being suspended — a different thing
  // from the member's own standing, which is what this is. registerForEvent,
  // selfCheckIn and withdrawFromEvent all start with requirePlayer().
  const standing = useStanding();

  if (isDoubles) {
    if (playerRegistration) {
      return (
        <div className="flex items-center gap-2">
          <span
            className={`chip ${playerRegistration.status === 'checked_in' ? 'chip-success' : ''}`}
            style={playerRegistration.status !== 'checked_in' ? { borderColor: 'rgba(59,130,246,0.35)', background: 'rgba(59,130,246,0.1)', color: '#93C5FD' } : undefined}
            role="status"
          >
            <span className="sr-only">Registration status: </span>
            {playerRegistration.status === 'checked_in' ? '✓ Checked In' : 'Registered (Doubles)'}
          </span>
        </div>
      );
    }
    return (
      <p className="text-xs text-[var(--text-secondary)] italic">
        Doubles registration is managed by the tournament admin.
      </p>
    );
  }

  async function handleRegister(eventWaiverAccepted?: boolean) {
    setLoading(true);
    try {
      const res = await registerForEvent(eventId, eventWaiverAccepted ? { eventWaiverAccepted: true } : undefined);
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
      toast('Registered successfully!', 'success');
      setWaiverOpen(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to register', 'error');
    }
    setLoading(false);
  }

  async function handleWithdraw() {
    if (!(await confirm({ title: 'Withdraw from event?', message: 'Are you sure you want to withdraw from this event?', confirmLabel: 'Withdraw', danger: true }))) return;
    setLoading(true);
    try {
      const res = await withdrawFromEvent(eventId);
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
      toast('Withdrawn from event', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to withdraw', 'error');
    }
    setLoading(false);
  }

  async function handleCheckIn() {
    setLoading(true);
    try {
      const res = await selfCheckIn(eventId);
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
      toast('Checked in!', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to check in', 'error');
    }
    setLoading(false);
  }

  const waiverText = eventWaiverText?.trim();

  // Registration status chips (below) still render; only the live controls go.
  if (!standing.ok && !playerRegistration) {
    return eventStatus === 'registration'
      ? <StandingNote standing={standing} activity="Entries" />
      : null;
  }

  if (!playerRegistration) {
    if (eventStatus === 'registration' && !suspended) {
      if (waiverText) {
        return (
          <>
            <Button
              onClick={() => { setWaiverAccepted(false); setWaiverOpen(true); }}
              loading={loading}
              size="sm"
              className="press min-h-[44px] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
            >
              <UserPlus className="w-3.5 h-3.5 mr-1.5" />
              Register
            </Button>
            <Dialog open={waiverOpen} onClose={() => setWaiverOpen(false)} title="Event waiver">
              <div className="space-y-4">
                <div style={{ maxHeight: '50vh', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 10, padding: 14 }}>
                  <LegalMarkdown content={waiverText} />
                </div>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, lineHeight: 1.5, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={waiverAccepted}
                    onChange={(e) => setWaiverAccepted(e.target.checked)}
                    style={{ marginTop: 2, accentColor: 'var(--red)', flexShrink: 0 }}
                  />
                  <span>I have read and accept the event waiver.</span>
                </label>
                <div className="flex items-center justify-between">
                  <Button variant="ghost" type="button" onClick={() => setWaiverOpen(false)}>Cancel</Button>
                  <Button loading={loading} disabled={!waiverAccepted} onClick={() => handleRegister(true)}>
                    Register
                  </Button>
                </div>
              </div>
            </Dialog>
          </>
        );
      }
      return (
        <Button
          onClick={() => handleRegister()}
          loading={loading}
          size="sm"
          className="press min-h-[44px] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
        >
          <UserPlus className="w-3.5 h-3.5 mr-1.5" />
          Register
        </Button>
      );
    }
    return null;
  }

  const regStatus = playerRegistration.status;
  const stillIn = regStatus === 'registered' || regStatus === 'checked_in';
  const outOfEvent = isOutOfEvent(regStatus);
  // Once the bracket exists, withdrawing has to forfeit your matches and move
  // the round above — an admin action, not a self-service one. The server
  // refuses it either way; hiding the button keeps the two in step.
  const drawPublished = eventHasDraw(eventStatus);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {regStatus === 'registered' && eventStatus === 'checkin' && !suspended && standing.ok && (
        <Button
          onClick={handleCheckIn}
          loading={loading}
          size="sm"
          className="press min-h-[44px] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
        >
          <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
          Check In
        </Button>
      )}
      {stillIn && !drawPublished && standing.ok && (
        <Button
          onClick={handleWithdraw}
          loading={loading}
          size="sm"
          variant="ghost"
          className="press min-h-[44px] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
        >
          <UserMinus className="w-3.5 h-3.5 mr-1.5" />
          Withdraw
        </Button>
      )}
      {/* The button does not just disappear — say who can do it now, or the
          only reading available is that the app has lost the option. */}
      {stillIn && drawPublished && (
        <p className="text-xs text-[var(--text-secondary)] italic">
          You are in the draw. Ask a tournament admin if you need to withdraw.
        </p>
      )}
      {/* Registered, but check-in and withdrawal are both server-refused —
          say so rather than leave a bare chip where two buttons used to be. */}
      {stillIn && !drawPublished && !standing.ok && (
        <StandingNote standing={standing} activity="Check-in and withdrawal" />
      )}
      {outOfEvent && (
        <p className="text-xs text-[var(--text-secondary)] italic">
          {regStatus === 'withdrawn'
            ? 'You have withdrawn from this event.'
            : 'You have been disqualified from this event.'}
        </p>
      )}
    </div>
  );
}

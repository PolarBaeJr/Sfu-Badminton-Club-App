'use client';

import { useState } from 'react';
import { Button, Dialog, useConfirm } from '@badminton/ui';
import { EventWaiverConsent } from '../../EventWaiverConsent';
import { SoloEntryConsent } from '../../SoloEntryConsent';
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
  /**
   * `paired` means a FORMED TEAM; false means a lone entry, which in a doubles
   * event is somebody waiting to be given a partner. `partnerName` is display
   * only and may be null even when `paired` is true — nothing branches on it.
   */
  playerRegistration: {
    status: string;
    paired?: boolean;
    partnerName?: string | null;
  } | null;
  isDoubles: boolean;
  suspended?: boolean;
  eventWaiverText?: string | null;
}

export function EventActions({ eventId, eventStatus, playerRegistration, isDoubles, suspended, eventWaiverText }: Props) {
  const [loading, setLoading] = useState(false);
  const [waiverOpen, setWaiverOpen] = useState(false);
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  // The doubles acknowledgement, separate from the waiver's: two different
  // things are being agreed to and a tournament may require either, both or
  // neither.
  const [soloAccepted, setSoloAccepted] = useState(false);
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();
  // `suspended` above is the TOURNAMENT being suspended — a different thing
  // from the member's own standing, which is what this is. registerForEvent,
  // selfCheckIn and withdrawFromEvent all start with requirePlayer().
  const standing = useStanding();

  // A member in a FORMED TEAM — the one doubles state with no self-service
  // controls. Leaving a pair puts the PARTNER back in the pool as well, and
  // nothing here can tell them that happened, so it is an exec action
  // (withdrawPairMember). Name the partner and name who to ask: a chip on its
  // own would read as the app having lost the option.
  const paired = isDoubles && Boolean(playerRegistration?.paired);
  if (paired) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`chip ${playerRegistration!.status === 'checked_in' ? 'chip-success' : ''}`}
          style={playerRegistration!.status !== 'checked_in' ? { borderColor: 'rgba(59,130,246,0.35)', background: 'rgba(59,130,246,0.1)', color: '#93C5FD' } : undefined}
          role="status"
        >
          <span className="sr-only">Registration status: </span>
          {playerRegistration!.status === 'checked_in' ? '✓ Checked In' : 'Paired'}
        </span>
        <p className="text-xs text-[var(--text-secondary)]">
          {playerRegistration!.partnerName
            ? <>Playing with <strong>{playerRegistration!.partnerName}</strong>.</>
            : 'You have been given a partner.'}
          {' '}Leaving now would put them back in the pool too, so ask a tournament admin if you
          need to withdraw.
        </p>
      </div>
    );
  }

  async function handleRegister(opts?: { eventWaiverAccepted?: boolean; soloEntryAcknowledged?: boolean }) {
    setLoading(true);
    try {
      const res = await registerForEvent(eventId, opts);
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
      toast(isDoubles ? 'Entered — waiting for a partner' : 'Registered successfully!', 'success');
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
  // A DOUBLES ENTRY ALWAYS GOES THROUGH THE DIALOG, waiver or no waiver — the
  // acknowledgement is what is being collected and the server refuses without
  // it. Singles with no waiver still enters on one tap.
  const needsDialog = Boolean(waiverText) || isDoubles;
  const canSubmit = (!waiverText || waiverAccepted) && (!isDoubles || soloAccepted);
  const enterOpts = {
    ...(waiverText ? { eventWaiverAccepted: true } : {}),
    ...(isDoubles ? { soloEntryAcknowledged: true } : {}),
  };

  // Registration status chips (below) still render; only the live controls go.
  if (!standing.ok && !playerRegistration) {
    return eventStatus === 'registration'
      ? <StandingNote standing={standing} activity="Entries" />
      : null;
  }

  if (!playerRegistration) {
    if (eventStatus === 'registration' && !suspended) {
      if (needsDialog) {
        return (
          <>
            <Button
              onClick={() => { setWaiverAccepted(false); setSoloAccepted(false); setWaiverOpen(true); }}
              loading={loading}
              size="sm"
              className="press min-h-[44px] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
            >
              <UserPlus className="w-3.5 h-3.5 mr-1.5" />
              {isDoubles ? 'Enter on your own' : 'Register'}
            </Button>
            <Dialog
              open={waiverOpen}
              onClose={() => setWaiverOpen(false)}
              title={isDoubles ? 'Enter without a partner' : 'Event waiver'}
            >
              <div className="space-y-4">
                {isDoubles && (
                  <SoloEntryConsent accepted={soloAccepted} onAcceptedChange={setSoloAccepted} />
                )}
                {waiverText && (
                  <EventWaiverConsent
                    text={waiverText}
                    accepted={waiverAccepted}
                    onAcceptedChange={setWaiverAccepted}
                  />
                )}
                <div className="flex items-center justify-between">
                  <Button variant="ghost" type="button" onClick={() => setWaiverOpen(false)}>Cancel</Button>
                  <Button loading={loading} disabled={!canSubmit} onClick={() => handleRegister(enterOpts)}>
                    Enter
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
      {/* An unpaired doubles entrant. No Check In: check-in in a doubles event
          happens on the PAIR, so offering it here is a button for a court they
          cannot yet take. Withdraw stays — leaving before you are paired
          affects nobody else, which is exactly why it is still theirs to do. */}
      {isDoubles && stillIn && (
        <span className="chip" style={{ borderColor: 'rgba(59,130,246,0.35)', background: 'rgba(59,130,246,0.1)', color: '#93C5FD' }} role="status">
          <span className="sr-only">Registration status: </span>Waiting for a partner
        </span>
      )}
      {!isDoubles && regStatus === 'registered' && eventStatus === 'checkin' && !suspended && standing.ok && (
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

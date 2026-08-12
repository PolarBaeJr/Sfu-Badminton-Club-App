'use client';

import { useState } from 'react';
import { Button, Dialog, useConfirm } from '@badminton/ui';
import { EventWaiverConsent } from './EventWaiverConsent';
import { SoloEntryConsent } from './SoloEntryConsent';
import { registerForEvent, withdrawFromEvent, selfCheckIn } from '@/lib/tournament-actions';
import type { ActionResult } from '@/lib/actions/_shared';
import { useToast } from '@/components/toast-provider';
import { useStanding } from '@/components/standing-provider';
import { useRouter } from 'next/navigation';

interface Props {
  eventId: string;
  eventStatus: string;
  /** `partnerName` present means a FORMED TEAM; absent means a lone entry. */
  registration: { status: string; partnerName?: string | null } | null;
  isDoubles: boolean;
  suspended?: boolean;
  eventWaiverText?: string | null;
}

export function EventRegistrationButton({ eventId, eventStatus, registration, isDoubles, suspended, eventWaiverText }: Props) {
  const [loading, setLoading] = useState(false);
  const [waiverOpen, setWaiverOpen] = useState(false);
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  // The doubles acknowledgement. Its own state and not folded into
  // `waiverAccepted`, because they are two different things being agreed to and
  // a tournament may require one, the other, both or neither.
  const [soloAccepted, setSoloAccepted] = useState(false);
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();
  // Member standing, not the tournament's `suspended` flag above. This is the
  // compact per-event row on the tournament page; the event's own page carries
  // the explanation, and the app-wide banner carries it everywhere, so here we
  // only withhold the buttons and leave the status chips.
  const standing = useStanding();

  // A member in a FORMED TEAM. This is the only doubles state that still has no
  // controls: leaving a pair takes somebody else's team away from them and puts
  // them back in the pool, so it is an exec action — see withdrawFromEvent. Say
  // who the partner is and who to ask, rather than showing a bare chip and
  // letting the missing button read as the app having lost the option.
  if (isDoubles && registration?.partnerName !== undefined && registration.partnerName !== null) {
    return (
      <div className="flex items-center gap-1.5">
        <span
          className={`chip ${registration.status === 'checked_in' ? 'chip-success' : 'chip-info'}`}
          role="status"
        >
          <span className="sr-only">Registration status: </span>
          {registration.status === 'checked_in' ? 'Checked In' : 'Paired'}
        </span>
        <span className="text-[10px] text-[var(--text-muted)]">with {registration.partnerName}</span>
      </div>
    );
  }

  async function act(fn: () => Promise<ActionResult>, msg: string) {
    setLoading(true);
    try {
      const res = await fn();
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
      toast(msg, 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  const waiverText = eventWaiverText?.trim();
  // A DOUBLES ENTRY ALWAYS GOES THROUGH THE DIALOG, waiver or no waiver: the
  // acknowledgement is the thing being collected, and registerForEvent refuses
  // without it. A singles entry with no waiver still registers on one tap.
  const needsDialog = Boolean(waiverText) || isDoubles;
  const canSubmit = (!waiverText || waiverAccepted) && (!isDoubles || soloAccepted);

  if (!registration) {
    if (eventStatus === 'registration' && !suspended && standing.ok) {
      if (needsDialog) {
        return (
          <>
            <Button
              size="sm"
              loading={loading}
              onClick={() => { setWaiverAccepted(false); setSoloAccepted(false); setWaiverOpen(true); }}
              className="press focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none min-h-[36px]"
            >
              Enter
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
                  <Button
                    loading={loading}
                    disabled={!canSubmit}
                    onClick={() =>
                      act(async () => {
                        const r = await registerForEvent(eventId, {
                          ...(waiverText ? { eventWaiverAccepted: true } : {}),
                          ...(isDoubles ? { soloEntryAcknowledged: true } : {}),
                        });
                        if (r.ok) setWaiverOpen(false);
                        return r;
                      }, isDoubles ? 'Entered — waiting for a partner' : 'Registered!')
                    }
                  >
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
          size="sm"
          loading={loading}
          onClick={() => act(() => registerForEvent(eventId), 'Registered!')}
          className="press focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none min-h-[36px]"
        >
          Register
        </Button>
      );
    }
    return null;
  }

  const s = registration.status;
  // An unpaired doubles entrant: entered, invoiced, signed — and with no team
  // yet, so nothing to check in. Check-in in a doubles event is done on the
  // PAIR, and offering it here would be a button for a court they cannot take.
  const waitingForPartner = isDoubles;

  return (
    <div className="flex items-center gap-1.5" onClick={(e) => e.preventDefault()}>
      {waitingForPartner && (
        <span className="chip chip-info" role="status">
          <span className="sr-only">Registration status: </span>Waiting for a partner
        </span>
      )}
      {!waitingForPartner && s === 'registered' && eventStatus === 'checkin' && !suspended && standing.ok && (
        <Button
          size="sm"
          loading={loading}
          onClick={() => act(() => selfCheckIn(eventId), 'Checked in!')}
          className="press focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none min-h-[36px]"
        >
          Check In
        </Button>
      )}
      {(s === 'registered' || s === 'checked_in') && eventStatus !== 'completed' && standing.ok && (
        <Button
          size="sm"
          variant="ghost"
          loading={loading}
          className="press focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none min-h-[36px]"
          onClick={async () => {
            if (await confirm({ title: 'Withdraw from event?', message: 'Are you sure you want to withdraw from this event?', confirmLabel: 'Withdraw', danger: true })) {
              act(() => withdrawFromEvent(eventId), 'Withdrawn');
            }
          }}
        >
          Withdraw
        </Button>
      )}
      {!waitingForPartner && s === 'checked_in' && (
        <span className="chip chip-success" role="status">
          <span className="sr-only">Registration status: </span>Checked In
        </span>
      )}
      {!waitingForPartner && s === 'registered' && eventStatus !== 'checkin' && (
        <span
          className="chip chip-info"
          role="status"
        >
          <span className="sr-only">Registration status: </span>Registered
        </span>
      )}
    </div>
  );
}

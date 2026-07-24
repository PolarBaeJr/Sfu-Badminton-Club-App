'use client';

import { useState } from 'react';
import { Button, Dialog, LegalMarkdown, useConfirm } from '@badminton/ui';
import { registerForEvent, withdrawFromEvent, selfCheckIn } from '@/lib/tournament-actions';
import type { ActionResult } from '@/lib/actions/_shared';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';

interface Props {
  eventId: string;
  eventStatus: string;
  registration: { status: string } | null;
  isDoubles: boolean;
  suspended?: boolean;
  eventWaiverText?: string | null;
}

export function EventRegistrationButton({ eventId, eventStatus, registration, isDoubles, suspended, eventWaiverText }: Props) {
  const [loading, setLoading] = useState(false);
  const [waiverOpen, setWaiverOpen] = useState(false);
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  if (isDoubles) {
    if (registration) {
      return (
        <span
          className={`chip ${registration.status === 'checked_in' ? 'chip-success' : 'chip-info'}`}
          role="status"
        >
          <span className="sr-only">Registration status: </span>
          {registration.status === 'checked_in' ? 'Checked In' : 'Registered'}
        </span>
      );
    }
    return (
      <span className="text-[10px] text-[var(--text-muted)] italic">
        Doubles — admin managed
      </span>
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

  if (!registration) {
    if (eventStatus === 'registration' && !suspended) {
      if (waiverText) {
        return (
          <>
            <Button
              size="sm"
              loading={loading}
              onClick={() => { setWaiverAccepted(false); setWaiverOpen(true); }}
              className="press focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none min-h-[36px]"
            >
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
                  <Button
                    loading={loading}
                    disabled={!waiverAccepted}
                    onClick={() =>
                      act(async () => {
                        const r = await registerForEvent(eventId, { eventWaiverAccepted: true });
                        if (r.ok) setWaiverOpen(false);
                        return r;
                      }, 'Registered!')
                    }
                  >
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

  return (
    <div className="flex items-center gap-1.5" onClick={(e) => e.preventDefault()}>
      {s === 'registered' && eventStatus === 'checkin' && !suspended && (
        <Button
          size="sm"
          loading={loading}
          onClick={() => act(() => selfCheckIn(eventId), 'Checked in!')}
          className="press focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none min-h-[36px]"
        >
          Check In
        </Button>
      )}
      {(s === 'registered' || s === 'checked_in') && eventStatus !== 'completed' && (
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
      {s === 'checked_in' && (
        <span className="chip chip-success" role="status">
          <span className="sr-only">Registration status: </span>Checked In
        </span>
      )}
      {s === 'registered' && eventStatus !== 'checkin' && (
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

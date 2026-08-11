'use client';

// THE LOUD BIT IN BETWEEN. Permissive at entry, strict at participation — and
// this is what stops "strict at participation" being a surprise at the door.
//
// A member an exec added never went through registration, so nobody ever showed
// them the event waiver. Three things now push it at them: a notification when
// they are added, this panel, and the refusal at check-in. Only the third is
// load-bearing; the first two exist so that nobody finds out at the front of a
// queue.
//
// ---------------------------------------------------------------------------
// WHY THIS BLOCKS THE TOURNAMENT AND NOT THE APP
// ---------------------------------------------------------------------------
// The obvious-looking alternative is the app-wide overlay the four club
// documents use (components/waiver-gate.tsx, driven by legal_documents). It
// would be wrong here for the same reason 00074's header spends a page warning
// against putting an event waiver in legal_documents: those four are things
// EVERY member must have accepted, and being locked out of sessions, challenges
// and the ladder over one tournament somebody else entered you in punishes a
// member for an exec's action.
//
// So the block is scoped to the thing that needs signing. It sits above the
// event list on the tournament it belongs to, it cannot be dismissed, and it
// carries the signature button itself — there is nowhere else to go and nothing
// else to do.
//
// It is deliberately NOT routed through getMissingLegalDocuments. That helper
// reads legal_documents unfiltered at three call sites, and anything it reports
// as missing blocks check-in, challenges and registration club-wide.

import { useState } from 'react';
import { Button } from '@badminton/ui';
import { useRouter } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';
import { acceptEventWaiver } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { EventWaiverConsent } from './EventWaiverConsent';

export function EventWaiverGate({
  tournamentId,
  text,
  state,
}: {
  tournamentId: string;
  text: string;
  /** 'unsigned' — never asked. 'stale' — the club edited the wording. */
  state: 'unsigned' | 'stale';
}) {
  const [accepted, setAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  async function submit() {
    setLoading(true);
    try {
      const result = await acceptEventWaiver(tournamentId, { accepted });
      if (!result.ok) {
        toast(result.error, 'error');
        setLoading(false);
        return;
      }
      toast('Event waiver accepted', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <div
      className="card-base"
      style={{ marginBottom: 20, borderColor: 'var(--red)' }}
      role="alert"
      data-testid="event-waiver-gate"
    >
      <div className="card-head" style={{ alignItems: 'flex-start' }}>
        <div className="row" style={{ gap: 8 }}>
          <ShieldAlert size={18} style={{ color: 'var(--red)', flexShrink: 0 }} />
          <h3 className="card-title">You must accept the event waiver</h3>
        </div>
        <span className="tag tag-red">ACTION NEEDED</span>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0, marginBottom: 14 }}>
        {/* Two different facts, said as two different sentences. Someone whose
            signature went stale did nothing wrong and should not be told they
            failed to do something. */}
        {state === 'stale'
          ? 'The wording of this tournament’s event waiver has changed since you accepted it, so your acceptance no longer covers it. Read the new version and accept it below.'
          : 'You are entered in this tournament, but you have not accepted its event waiver. You cannot be checked in until you do.'}
      </p>
      <div className="space-y-4">
        <EventWaiverConsent text={text} accepted={accepted} onAcceptedChange={setAccepted} />
        <div className="flex items-center justify-end">
          <Button loading={loading} disabled={!accepted} onClick={submit}>
            Accept event waiver
          </Button>
        </div>
      </div>
    </div>
  );
}

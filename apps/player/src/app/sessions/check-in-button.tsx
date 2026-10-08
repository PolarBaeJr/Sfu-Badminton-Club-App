'use client';
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { checkInToSession, checkInWithToken } from '@/lib/actions';
import { CheckCircle2, Loader2, QrCode, X } from 'lucide-react';
import { useToast } from '@/components/toast-provider';
import { useStanding } from '@/components/standing-provider';
import { QrScanner } from '@/components/qr-scanner';
import {
  UNREADABLE_SCAN_MESSAGE,
  checkInAffordances,
  tokenFromCheckinScan,
} from '@/lib/checkin-scan';
import {
  IDLE_SCAN,
  clearedScanError,
  failedScan,
  restartedScan,
} from '@/lib/scan-retry';

interface CheckInButtonProps {
  sessionId: string;
  myStatus: 'checked_in' | 'present' | 'no_show' | 'excused' | null;
  canCheckIn: boolean;
  windowLabel?: string;
  myIntent?: 'going' | 'declined' | null;
  /** This session requires the door code — see requiresScanToCheckIn. Defaults
   *  to today's behaviour so a caller that has not been updated cannot
   *  accidentally impose the strict policy on a night nobody set it for. */
  requireScan?: boolean;
}

export function CheckInButton({ sessionId, myStatus, canCheckIn, windowLabel, myIntent, requireScan = false }: CheckInButtonProps) {
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  // The camera's retry state, shared with the tournament scanner — see
  // lib/scan-retry. QrScanner latches itself off the moment it decodes
  // anything, so a fresh key is what actually restarts the loop; flipping a
  // boolean would leave a dead camera on screen.
  const [scan, setScan] = useState(IDLE_SCAN);
  const { toast } = useToast();
  const standing = useStanding();
  const router = useRouter();
  // One decision, read in three places below. Derived rather than tested
  // inline so "under scan-required nothing here offers a direct check-in" is a
  // property of a single function that a test can assert whole.
  const affordances = checkInAffordances(requireScan);

  // A failed scan stops the camera and waits for a tap — it must NOT restart
  // itself. The reasoning, and the loop it avoids, live in lib/scan-retry.
  const failScan = useCallback((message: string) => {
    setScan((s) => failedScan(s, message));
  }, []);

  const openScanner = useCallback(() => {
    setScan(restartedScan);
    setScanning(true);
  }, []);

  const onScan = useCallback(
    async (raw: string) => {
      const token = tokenFromCheckinScan(raw);
      if (!token) {
        failScan(UNREADABLE_SCAN_MESSAGE);
        return;
      }
      setLoading(true);
      setScan(clearedScanError);
      try {
        const res = await checkInWithToken(token);
        if (!res.ok) {
          setLoading(false);
          failScan(res.error);
          return;
        }
        setScanning(false);
        setLoading(false);
        // The token IS the session — it carries no identity and no notion of
        // which card the member happened to be looking at. Scanning the code on
        // the door of the hall you are standing in is the right answer even if
        // the list on screen is stale, so a mismatch checks them into the
        // scanned session and says so rather than refusing. We only hold an id,
        // not a name; naming it would cost a round-trip at the door.
        if (res.data.sessionId !== sessionId) {
          toast('That code was for a different session — you’re checked in to that one.', 'info');
        } else if (res.data.alreadyCheckedIn) {
          toast('You were already checked in.', 'info');
        } else {
          toast('Checked in.', 'success');
        }
        // The action revalidates /sessions, but a cross-session scan changes a
        // card this component does not own; refresh so that one updates too.
        router.refresh();
      } catch (err) {
        console.error(err);
        setLoading(false);
        failScan(err instanceof Error ? err.message : 'Failed to check in. Please try again.');
      }
    },
    [failScan, router, sessionId, toast],
  );

  if (myStatus === 'checked_in' || myStatus === 'present') {
    return (
      <span className="chip chip-success">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        {myStatus === 'present' ? 'Attended' : 'Checked In'}
      </span>
    );
  }

  if (myStatus === 'no_show') {
    return <span className="chip">No-show</span>;
  }

  if (myStatus === 'excused') {
    return <span className="chip">Excused</span>;
  }

  // Declined ("Not going") — don't offer check-in; the RSVP row keeps a way to
  // switch to Going.
  if (myIntent === 'declined') {
    return null;
  }

  // checkInToSession -> requirePlayer() refuses this. The attendance chips
  // above still render, so a member who was already checked in keeps that on
  // screen; only the live button goes. The Upcoming card head says why.
  if (!standing.ok) {
    return null;
  }

  // Check-in not open (and no attendance status to show) — render nothing
  // rather than a dead, disabled "Check-in closed" button.
  if (!canCheckIn) {
    return null;
  }

  async function handleCheckIn() {
    setLoading(true);
    try {
      const res = await checkInToSession(sessionId);
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
      }
    } catch (err) {
      console.error(err);
      toast(err instanceof Error ? err.message : 'Failed to check in. Please try again.', 'error');
      setLoading(false);
    }
  }

  return (
    <>
      <button
        onClick={openScanner}
        disabled={loading || !canCheckIn}
        className="press btn-primary-cta text-white rounded-xl px-4 py-2 text-sm font-semibold min-h-[44px] whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <span className="row" style={{ gap: 6 }}>
          <QrCode size={15} className="shrink-0" />
          {!canCheckIn ? (windowLabel ?? 'Check-in closed') : loading ? 'Checking in...' : 'Scan to Check In'}
        </span>
      </button>

      {/* Supplement mode keeps the direct action ON THE CARD, one tap, exactly
          where it has always been. Buried inside the scanner dialog it would
          have cost a tap AND a camera permission prompt to reach — a member who
          only wants to tap check-in must never have to meet that prompt — and
          the note above this component in session-card says check-in "must not
          move further from their thumb than it was". On a session marked
          scan-required this is gone and the scan is the only way in.

          It is a text control, not a bordered button, and that is the whole
          point of the change: as `btn btn-ghost btn-sm` it sat beside the solid
          red primary in a different type treatment (uppercase letterspaced
          against title-case bold) and read as a second, competing check-in. One
          primary per card. The 44px floor lives in .sess-textlink, so demoting
          the LOOK did not shrink the target. */}
      {affordances.directOnCard && (
        <button
          type="button"
          onClick={handleCheckIn}
          disabled={loading}
          className="sess-textlink"
        >
          Check in without scanning
        </button>
      )}

      {scanning && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Scan the check-in code"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            background: 'var(--bg-overlay)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            className="card-base"
            style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <div className="card-title">Scan the check-in code</div>
                <div className="card-sub">It&rsquo;s on the door of the hall.</div>
              </div>
              <button
                type="button"
                onClick={() => setScanning(false)}
                aria-label="Close scanner"
                className="btn btn-ghost"
                style={{ padding: 8, minWidth: 0 }}
              >
                <X size={16} />
              </button>
            </div>

            {scan.error && (
              <div className="alert-danger" role="alert" style={{ fontSize: 13 }}>
                {scan.error}
              </div>
            )}

            {/* QrScanner handles a denied permission, a missing camera and an
                insecure origin by rendering its own message and never calling
                onResult — the parent is not told which. That is why the way out
                below is unconditional rather than shown "on failure": whichever
                of the three happened, the member lands on something.

                Unmounted after a failure so the camera really stops, and
                brought back only by a tap on "Scan again" — the code that just
                failed is still the code in front of the lens. */}
            {scan.stopped ? (
              <button
                type="button"
                onClick={openScanner}
                className="btn btn-primary btn-lg rounded-[8px]"
                style={{ width: '100%', justifyContent: 'center' }}
              >
                <QrCode size={16} /> Scan again
              </button>
            ) : (
              <QrScanner key={scan.attempt} onResult={onScan} paused={loading} />
            )}

            {loading && (
              <p className="muted row" style={{ fontSize: 13, gap: 6, margin: 0 }}>
                <Loader2 size={14} className="animate-spin" /> Checking you in&hellip;
              </p>
            )}

            {affordances.cameraFallback === 'printed-code' ? (
              // Presence is required, so there is no button here on purpose:
              // "camera denied" must not be a route to checking in from home.
              // The printed code and the phone's own camera app still work —
              // /checkin/[token] is untouched — and that path needs no
              // in-browser camera permission at all.
              <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
                Camera not working? Open your phone&rsquo;s camera app and point it at the
                same code — it opens this check-in in your browser. Otherwise ask an exec.
              </p>
            ) : (
              <>
                {affordances.directInDialog && (
                  <button
                    type="button"
                    onClick={() => {
                      setScanning(false);
                      void handleCheckIn();
                    }}
                    disabled={loading}
                    className="btn btn-ghost"
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    Check in without scanning
                  </button>
                )}
                <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
                  Or open your phone&rsquo;s camera app on the same code.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

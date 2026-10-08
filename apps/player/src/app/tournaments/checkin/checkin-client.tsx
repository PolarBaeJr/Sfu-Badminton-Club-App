'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@badminton/ui';
import { QrCode } from 'lucide-react';
import { QrScanner } from '@/components/qr-scanner';
import { useStanding } from '@/components/standing-provider';
import { checkInToTournament, type TournamentCheckInResult } from '@/lib/tournament-checkin';
import {
  classifyTournamentScan,
  SESSION_CODE_SCAN_MESSAGE,
  UNREADABLE_TOURNAMENT_SCAN_MESSAGE,
} from '@/lib/tournament-scan';
import {
  IDLE_SCAN,
  clearedScanError,
  failedScan,
  restartedScan,
} from '@/lib/scan-retry';

export function TournamentCheckInClient({ initialToken }: { initialToken?: string }) {
  const [result, setResult] = useState<TournamentCheckInResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [scanning, setScanning] = useState(!initialToken);
  // The camera's retry state — the key it is mounted under, whether it has been
  // torn down after a failure, and what went wrong. See lib/scan-retry for why
  // a key is the only thing that can restart a QrScanner, and why the old
  // `setScanning(true)` on failure (on a `scanning` that was already true) was
  // a state write with no state change and therefore no remount at all.
  const [scan, setScan] = useState(IDLE_SCAN);
  const router = useRouter();
  // Signed-out visitors read as good standing here (this page is public), so
  // they keep the existing behaviour of scanning and being sent to sign in.
  const standing = useStanding();

  const failScan = useCallback((message: string) => {
    setScan((s) => failedScan(s, message));
  }, []);

  const restartScan = useCallback(() => {
    setScan(restartedScan);
    setScanning(true);
  }, []);

  const submit = useCallback(async (token: string) => {
    setSubmitting(true);
    setScan(clearedScanError);
    const res = await checkInToTournament(token);
    setSubmitting(false);
    if (!res.ok) {
      // Let them try again rather than stranding them on a dead screen — a
      // mis-scan at the door should not need a page reload. The camera is torn
      // down and "Scan again" brings a fresh one back.
      //
      // setScanning(true) matters only on the native-camera path, where
      // `scanning` started false because a ?token= was already present. That is
      // the accident that hid this bug for so long: arriving with a bad token
      // in the URL recovered correctly, and only the in-app scanner — where
      // `scanning` was already true — was left dead.
      failScan(res.error);
      setScanning(true);
      return;
    }
    setResult(res.data);
    setScanning(false);
    router.refresh();
  }, [failScan, router]);

  const onScan = useCallback((raw: string) => {
    const scan = classifyTournamentScan(raw);
    // Every miss goes through failScan, not just the server's. An early return
    // that only set an error left a latched-off scanner mounted: a live-looking
    // video that would never decode again, with a message underneath it.
    if (scan.kind === 'session-code') {
      failScan(SESSION_CODE_SCAN_MESSAGE);
      return;
    }
    if (scan.kind === 'unreadable') {
      failScan(UNREADABLE_TOURNAMENT_SCAN_MESSAGE);
      return;
    }
    void submit(scan.token);
  }, [failScan, submit]);

  // Arrived via the native camera with ?token= already present — check in
  // immediately rather than asking them to scan the code they just scanned.
  //
  // MUST be an effect. Calling a server action during render throws on Next 15
  // ("Server Functions cannot be called during initial render"), which broke
  // exactly the path most people use: scanning the printed code with the phone
  // camera. Next 14 tolerated it, so this only surfaced by running the built
  // app rather than by compiling it.
  const autoRan = useRef(false);
  useEffect(() => {
    if (!initialToken || autoRan.current) return;
    // Don't fire a request the server is certain to refuse; the screen below
    // already explains why, and an auto-run would race it with an error state.
    if (!standing.ok) return;
    autoRan.current = true;
    void submit(initialToken);
  }, [initialToken, submit, standing.ok]);

  // checkInToTournament starts with requirePlayer(), so don't open the camera
  // to someone it will refuse — being told at the door, before scanning, is
  // the difference between a queue moving and a queue stopping.
  if (!standing.ok) {
    return (
      <div className="card-base" role="status">
        <h2 className="card-title">Check-in paused</h2>
        <p className="muted" style={{ fontSize: 13, marginTop: 6, maxWidth: '52ch' }}>{standing.detail}</p>
      </div>
    );
  }

  if (result) {
    // The heading follows what actually happened. A scan that was refused an
    // event is not a clean "Checked in", and a screen that says so anyway is
    // how somebody walks away believing they are in a draw they are not in.
    const anyRefused = result.refused.length > 0;
    return (
      <div className="card-base" role="status">
        <h2 className="card-title">{anyRefused ? 'Partly checked in' : 'Checked in'}</h2>
        <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>{result.tournamentName}</p>
        {result.checkedIn.length > 0 && (
          <ul style={{ marginTop: 12, paddingLeft: 18 }}>
            {result.checkedIn.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        {result.alreadyIn.length > 0 && (
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Already checked in: {result.alreadyIn.join(', ')}
          </p>
        )}
        {anyRefused && (
          <div style={{ marginTop: 12 }}>
            <p style={{ fontSize: 13, fontWeight: 600 }}>Not checked in:</p>
            <ul style={{ marginTop: 4, paddingLeft: 18 }}>
              {result.refused.map((r) => (
                <li key={r.event} style={{ fontSize: 13 }}>{r.event} — {r.detail}</li>
              ))}
            </ul>
          </div>
        )}
        {/*
          MUTED, AND IT NEVER TOUCHES THE HEADING. These are events whose
          check-in has not opened yet, which is the ordinary shape of a
          multi-event tournament rather than anything that went wrong -- the
          member simply scans again later. Rendering them alongside the
          refusals, or letting them make the scan "Partly checked in", would
          make almost every successful scan read as a failure.
        */}
        {result.pending.length > 0 && (
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Opens later: {result.pending.map((p) => p.event).join(', ')}
          </p>
        )}
        <Button style={{ marginTop: 16 }} onClick={() => router.push('/tournaments')}>
          Done
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {scan.error && (
        <div className="card-base" role="alert">
          <p style={{ fontSize: 13, margin: 0 }}>{scan.error}</p>
        </div>
      )}
      {submitting && <p className="muted" style={{ fontSize: 13 }}>Checking you in…</p>}

      {/* Unmounted after a failure so the camera really stops, and brought back
          only by a tap — a fresh key is the only thing that can restart it. */}
      {scanning && (scan.stopped ? (
        <button
          type="button"
          onClick={restartScan}
          className="btn btn-primary btn-lg rounded-[8px]"
          style={{ width: '100%', justifyContent: 'center' }}
        >
          <QrCode size={16} /> Scan again
        </button>
      ) : (
        <QrScanner key={scan.attempt} onResult={onScan} paused={submitting} />
      ))}

      <p className="muted" style={{ fontSize: 12 }}>
        Point your camera at the check-in code an exec is showing. One scan checks
        you into every event you are entered in.
      </p>

      {/* THE WAY OUT WITHOUT A CAMERA, and it is unconditional on purpose.
          QrScanner handles a denied permission, a missing camera and an
          insecure origin by rendering its own message and never calling
          onResult — the parent is never told which, or even that it happened.
          So this cannot be shown "on failure"; whichever of the three occurred,
          the member lands on something. Before this, a member who tapped Deny
          once saw a red box and a line telling them to point a camera they had
          just refused: a dead end, with no mention of the two routes that still
          work. Both need no in-browser camera permission at all. */}
      <p className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
        Camera not working? Open your phone&rsquo;s camera app and point it at the same
        code — it opens this check-in in your browser. Otherwise ask an exec to check
        you in.
      </p>
    </div>
  );
}

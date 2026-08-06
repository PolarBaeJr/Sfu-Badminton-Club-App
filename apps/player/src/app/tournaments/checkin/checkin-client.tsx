'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@badminton/ui';
import { QrScanner } from '@/components/qr-scanner';
import { useStanding } from '@/components/standing-provider';
import { checkInToTournament, type TournamentCheckInResult } from '@/lib/tournament-checkin';

// The QR encodes a full URL so a phone's native camera also works — scanning
// with the built-in camera app opens this page with ?token= already set, and
// the in-app scanner below is for people who are already in the app.
function tokenFromScan(raw: string): string | null {
  const trimmed = raw.trim();
  // A bare token, if the code was generated as plain text.
  if (/^[0-9a-f]{48}$/.test(trimmed)) return trimmed;
  try {
    return new URL(trimmed).searchParams.get('token');
  } catch {
    return null;
  }
}

export function TournamentCheckInClient({ initialToken }: { initialToken?: string }) {
  const [result, setResult] = useState<TournamentCheckInResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [scanning, setScanning] = useState(!initialToken);
  const router = useRouter();
  // Signed-out visitors read as good standing here (this page is public), so
  // they keep the existing behaviour of scanning and being sent to sign in.
  const standing = useStanding();

  const submit = useCallback(async (token: string) => {
    setSubmitting(true);
    setError(null);
    const res = await checkInToTournament(token);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      // Let them try again rather than stranding them on a dead screen — a
      // mis-scan at the door should not need a page reload.
      setScanning(true);
      return;
    }
    setResult(res.data);
    setScanning(false);
    router.refresh();
  }, [router]);

  const onScan = useCallback((raw: string) => {
    const token = tokenFromScan(raw);
    if (!token) {
      setError('That does not look like a check-in code.');
      return;
    }
    void submit(token);
  }, [submit]);

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
    return (
      <div className="card-base" role="status">
        <h2 className="card-title">Checked in</h2>
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
        <Button style={{ marginTop: 16 }} onClick={() => router.push('/tournaments')}>
          Done
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="card-base" role="alert">
          <p style={{ fontSize: 13, margin: 0 }}>{error}</p>
        </div>
      )}
      {submitting && <p className="muted" style={{ fontSize: 13 }}>Checking you in…</p>}
      {scanning && <QrScanner onResult={onScan} paused={submitting} />}
      <p className="muted" style={{ fontSize: 12 }}>
        Point your camera at the check-in code an exec is showing. One scan checks
        you into every event you are entered in.
      </p>
    </div>
  );
}

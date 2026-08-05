'use client';

import { useState } from 'react';
import { Button, Dialog, useConfirm } from '@badminton/ui';
import { QrCode } from 'lucide-react';
import { useToast } from '@/components/toast-provider';
import {
  getOrCreateTournamentCheckinToken,
  rotateTournamentCheckinToken,
} from '@/lib/actions/tournament-checkin';

// The QR encodes a URL on the PLAYER app, so a phone's native camera opens it
// directly — no app install, no typing. The in-app scanner handles the case
// where someone is already inside the app.
//
// One code covers the whole tournament: scanning it checks a player into every
// event they are entered in, which is decided server-side from their own
// entries. The code carries no authority over anyone else's registration.
export function TournamentCheckinQr({ tournamentId }: { tournamentId: string }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const confirm = useConfirm();

  const playerUrl = process.env.NEXT_PUBLIC_PLAYER_URL || '';
  const url = token ? `${playerUrl.replace(/\/+$/, '')}/tournaments/checkin?token=${token}` : null;

  async function load() {
    setBusy(true);
    const res = await getOrCreateTournamentCheckinToken(tournamentId);
    setBusy(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    setToken(res.data);
    await renderQr(res.data);
  }

  // Rendered client-side from a URL we built ourselves — origin from env plus a
  // hex token the server minted — so the markup is never attacker-controlled.
  async function renderQr(t: string) {
    const target = `${playerUrl.replace(/\/+$/, '')}/tournaments/checkin?token=${t}`;
    const QRCode = (await import('qrcode')).default;
    setSvg(await QRCode.toString(target, { type: 'svg', margin: 1, width: 320 }));
  }

  async function handleRotate() {
    if (!(await confirm({
      title: 'Rotate code?',
      message: 'Issue a new code? Any QR already printed or displayed stops working immediately.',
      confirmLabel: 'Rotate',
      danger: true,
    }))) return;
    setBusy(true);
    const res = await rotateTournamentCheckinToken(tournamentId);
    setBusy(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    setToken(res.data);
    await renderQr(res.data);
    toast('Code rotated', 'success');
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => { setOpen(true); if (!token) void load(); }}
      >
        <QrCode className="w-3.5 h-3.5 mr-1" />
        Check-in QR
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Tournament check-in QR">
        {svg && url ? (
          <div className="space-y-4">
            <div
              className="flex justify-center bg-white rounded-lg p-4"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            <p className="text-sm text-[var(--text-secondary)] text-center">
              Players scan this to check into every event they are entered in.
            </p>
            <p className="text-xs font-mono break-all text-[var(--text-muted)] text-center">{url}</p>
            <div className="flex items-center justify-between pt-2 border-t border-[var(--border)]">
              <span className="text-xs text-[var(--text-muted)]">
                Rotating revokes every shared copy of the old code.
              </span>
              <Button variant="ghost" disabled={busy} onClick={handleRotate}>Rotate code</Button>
            </div>
          </div>
        ) : (
          <div className="py-4 text-center">
            <p className="text-sm text-[var(--text-muted)]">
              {busy ? 'Generating…' : 'No check-in code yet.'}
            </p>
            {!busy && <Button className="mt-3" onClick={() => void load()}>Generate code</Button>}
          </div>
        )}
      </Dialog>
    </>
  );
}

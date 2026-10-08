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
// The QR markup is ours (generated from a URL we built), but the tournament
// name is user-entered and goes into raw HTML in the print window.
function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

export function TournamentCheckinQr({ tournamentId, tournamentName }: { tournamentId: string; tournamentName?: string }) {
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

  // Opens a print sheet rather than downloading a file. What an exec wants is
  // paper on the door, and a downloaded .svg still needs opening in something
  // that can print it. This goes straight to the dialog, sized for the wall.
  //
  // A blank window rather than a print stylesheet on this page, because the QR
  // lives inside a Dialog inside the admin chrome — @media print would have to
  // hide the entire app around it, and would still be at the mercy of the
  // dialog's own overflow.
  function handlePrint() {
    if (!svg || !url) return;
    const w = window.open('', '_blank', 'width=820,height=1000');
    if (!w) { toast('Allow pop-ups to print the code', 'error'); return; }
    const title = tournamentName ? `${tournamentName} — check in` : 'Check in';
    w.document.write(`<!doctype html><html><head><meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  /* Deliberately self-contained and black-on-white: the app is a dark theme,
     and printing that wastes toner and scans worse. */
  @page { margin: 14mm; }
  body { margin:0; font-family: system-ui, sans-serif; color:#000; background:#fff;
         display:flex; flex-direction:column; align-items:center; justify-content:center;
         min-height:100vh; text-align:center; }
  h1 { font-size:34px; margin:0 0 4px; }
  p.sub { font-size:18px; margin:0 0 26px; color:#333; }
  .qr { width:min(74vw,460px); }
  .qr svg { width:100%; height:auto; display:block; }
  p.url { font-family:ui-monospace,monospace; font-size:11px; color:#555;
          margin-top:22px; word-break:break-all; max-width:70%; }
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<p class="sub">Scan to check in to every event you are entered in</p>
<div class="qr">${svg}</div>
<p class="url">${escapeHtml(url)}</p>
</body></html>`);
    w.document.close();
    w.focus();
    // Give the SVG a tick to lay out; printing immediately can capture a blank
    // page in Safari.
    setTimeout(() => w.print(), 250);
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
              <div className="flex gap-2">
                <Button variant="ghost" onClick={handlePrint}>Print</Button>
                <Button variant="ghost" disabled={busy} onClick={handleRotate}>Rotate code</Button>
              </div>
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

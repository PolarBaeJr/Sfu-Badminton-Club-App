'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '@badminton/ui';
import { generateQrForChallenge, getExistingQrForChallenge, type GeneratedQr } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import QRCode from 'qrcode';
import { QrCode, Download, Printer, RotateCw } from 'lucide-react';

type Props = {
  challengeId: string;
  status: string;
  hasExistingQr: boolean;
  hasMatch: boolean;
};

export function QrModalButton({ challengeId, status, hasExistingQr, hasMatch }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [qr, setQr] = useState<GeneratedQr | null>(null);
  const [dataUrl, setDataUrl] = useState<string>('');
  const { toast } = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const disabled = hasMatch || status !== 'accepted';
  const disabledReason = hasMatch
    ? 'Result already submitted'
    : status !== 'accepted'
      ? `Challenge is ${status.replace(/_/g, ' ')}`
      : '';

  async function loadExisting() {
    if (!hasExistingQr) return;
    try {
      const existing = await getExistingQrForChallenge(challengeId);
      if (existing) setQr(existing);
    } catch {
      // swallow — user can still regenerate
    }
  }

  async function handleOpen() {
    setOpen(true);
    if (hasExistingQr && !qr) await loadExisting();
  }

  async function handleGenerate() {
    setLoading(true);
    try {
      const next = await generateQrForChallenge(challengeId);
      setQr(next);
      toast('QR code generated', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to generate QR', 'error');
    }
    setLoading(false);
  }

  // Render QR onto canvas and grab a data URL for download.
  useEffect(() => {
    if (!qr || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, qr.url, {
      width: 280,
      margin: 1,
      color: { dark: '#000000', light: '#FFFFFF' },
      errorCorrectionLevel: 'M',
    }).catch(() => {
      toast('Failed to render QR code', 'error');
    });
    QRCode.toDataURL(qr.url, { width: 600, margin: 2, errorCorrectionLevel: 'M' })
      .then(setDataUrl)
      .catch(() => {});
  }, [qr, toast]);

  function handleDownload() {
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `challenge-qr-${challengeId.slice(0, 8)}.png`;
    a.click();
  }

  function handlePrint() {
    if (!dataUrl) return;
    const w = window.open('', '_blank', 'width=600,height=800');
    if (!w) return;
    const sideA = qr?.players.filter((p) => p.team_side === 'a').map((p) => p.full_name).join(' + ');
    const sideB = qr?.players.filter((p) => p.team_side === 'b').map((p) => p.full_name).join(' + ');
    w.document.write(`
      <html><head><title>Challenge QR</title></head>
      <body style="font-family:system-ui;text-align:center;padding:40px;">
        <h2>${sideA} vs ${sideB}</h2>
        <p>Expires: ${qr ? new Date(qr.expiresAt).toLocaleDateString() : ''}</p>
        <img src="${dataUrl}" alt="QR" style="width:300px;height:300px;"/>
        <p style="color:#666;font-size:12px;">Scan to submit match result</p>
        <script>window.onload=()=>setTimeout(()=>window.print(),300)</script>
      </body></html>
    `);
    w.document.close();
  }

  const sideA = qr?.players.filter((p) => p.team_side === 'a').map((p) => p.full_name).join(' + ') || '';
  const sideB = qr?.players.filter((p) => p.team_side === 'b').map((p) => p.full_name).join(' + ') || '';

  return (
    <>
      <button
        onClick={handleOpen}
        disabled={disabled}
        title={disabled ? disabledReason : hasExistingQr ? 'View existing QR' : 'Generate QR code'}
        className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md border text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          borderColor: 'var(--border)',
          background: 'transparent',
          color: 'var(--text-primary)',
        }}
      >
        <QrCode size={13} />
        {hasExistingQr ? 'QR' : 'Generate QR'}
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Match Result QR Code">
        <div className="space-y-4" style={{ minWidth: 320 }}>
          {!qr && !hasExistingQr && (
            <div className="space-y-3">
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                Generate a signed QR code players can scan to submit their match result. Expires in 14 days.
              </p>
              <Button onClick={handleGenerate} loading={loading} className="w-full">
                Generate QR Code
              </Button>
            </div>
          )}

          {qr && (
            <>
              <div className="text-center space-y-1">
                <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {sideA} <span style={{ color: 'var(--text-muted)' }}>vs</span> {sideB}
                </div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {qr.matchType} &middot; {qr.format}
                </div>
              </div>

              <div
                className="mx-auto rounded-lg"
                style={{
                  background: '#FFFFFF',
                  padding: 16,
                  width: 312,
                  height: 312,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <canvas ref={canvasRef} />
              </div>

              <div
                className="text-center text-xs font-mono"
                style={{ color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}
              >
                Expires: {new Date(qr.expiresAt).toLocaleString()}
              </div>

              <div className="flex gap-2">
                <Button onClick={handleDownload} variant="ghost" className="flex-1">
                  <Download size={14} className="mr-1.5" /> Download PNG
                </Button>
                <Button onClick={handlePrint} variant="ghost" className="flex-1">
                  <Printer size={14} className="mr-1.5" /> Print
                </Button>
              </div>

              <Button onClick={handleGenerate} loading={loading} variant="ghost" className="w-full text-xs">
                <RotateCw size={12} className="mr-1.5" /> Regenerate (invalidates existing)
              </Button>
            </>
          )}
        </div>
      </Dialog>
    </>
  );
}

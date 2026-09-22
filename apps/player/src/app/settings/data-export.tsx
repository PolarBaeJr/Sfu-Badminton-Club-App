'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useToast } from '@/components/toast-provider';

// The Settings row for the member data export (a FIPPA access request).
//
// NOT A BARE `<a download href="/api/account/export">`, and the two reasons are
// both about what the member sees when something goes wrong.
//
//   1. The route answers a failed assembly with 503 AND NO FILE, deliberately:
//      a partial export looks like a complete answer. An anchor renders that
//      503 body as raw JSON in a new tab, which is the worst possible reading
//      of "we could not do this". Fetching lets `res.ok` route the failure into
//      this page's own toast, like every other control here.
//   2. On the installed PWA a `target="_blank"` ejects the member from the app
//      entirely -- the same reason top-bar.tsx and the EXEC PANEL link in the
//      Danger zone are plain same-origin anchors with no target.
//
// The Blob download is the style exportCSV() uses in the console's
// LeaderboardTab: build the object URL, click a detached anchor, revoke.
export function DataExport() {
  const [downloading, setDownloading] = useState(false);
  const { toast } = useToast();

  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await fetch('/api/account/export');
      if (!res.ok) {
        // The route sends a sentence, not a stack trace. Read it if it is
        // there; say something useful if the response was not JSON at all
        // (a 502 from the edge, say, which never reached the app).
        let message = 'Could not build your data file. Please try again.';
        try {
          const body = await res.json();
          if (typeof body?.error === 'string') message = body.error;
        } catch {
          // Not JSON. Keep the generic sentence.
        }
        toast(message, 'error');
        setDownloading(false);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sfu-badminton-my-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Your data file has been downloaded', 'success');
    } catch {
      toast('Could not build your data file. Please try again.', 'error');
    }
    setDownloading(false);
  }

  return (
    <div className="settings-row">
      <div>
        <div className="settings-row-label">Download my data</div>
        <div className="settings-row-hint">
          A JSON file holding everything the club records about you: your profile, your ratings and
          reliability record, every session, match, challenge and tournament you took part in, your
          fees, the notifications and emails we sent you, and the club&apos;s record of
          administrative decisions about your account. Some information is withheld, including
          sign-in credentials and notes officers wrote about you. Each withholding is listed inside
          the file with the reason.
        </div>
      </div>
      <div className="settings-row-control">
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          className="btn btn-ghost"
        >
          {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {downloading ? 'Building' : 'Download'}
        </button>
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect } from 'react';
import { Copy, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { getCalendarFeedToken, regenerateCalendarFeedToken } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useConfirm } from '@badminton/ui';

// Settings rows for the personal ICS subscription feed. The token is a
// capability URL — anyone holding it can read the player's schedule, so
// resetting it is the revocation mechanism.
export function CalendarFeed() {
  const [token, setToken] = useState<string | null>(null);
  // Distinguish "still loading" from "failed": without this the component sat
  // on a skeleton forever whenever the action errored (e.g. requirePlayer()
  // rejecting an unapproved account), which reads as a broken empty box.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const { toast } = useToast();
  const confirm = useConfirm();

  useEffect(() => {
    getCalendarFeedToken()
      .then((res) => {
        if (res.ok) setToken(res.data);
        else setLoadError(res.error);
      })
      .catch(() => setLoadError('Could not load your calendar link.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCopy() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/api/calendar/${token}`
      );
      toast('Feed link copied', 'success');
    } catch {
      toast('Could not copy link', 'error');
    }
  }

  async function handleReset() {
    if (!(await confirm({ title: 'Reset calendar link?', message: 'Reset your calendar link? Calendars subscribed with the old link will stop updating.', confirmLabel: 'Reset link', danger: true }))) return;
    setResetting(true);
    try {
      const res = await regenerateCalendarFeedToken();
      if (!res.ok) {
        toast(res.error, 'error');
        setResetting(false);
        return;
      }
      setToken(res.data);
      toast('Calendar link reset', 'success');
    } catch {
      toast('Could not reset calendar link', 'error');
    }
    setResetting(false);
  }

  if (loadError) {
    return (
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>
        {loadError}
      </p>
    );
  }

  if (!token) {
    return <div className="skeleton" style={{ height: 120, borderRadius: 'var(--r-lg)' }} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="settings-row">
        <div>
          <div className="settings-row-label">Subscribe in your calendar</div>
          <div className="settings-row-hint">
            Opens your calendar app and keeps upcoming sessions in sync automatically.
          </div>
        </div>
        <div className="settings-row-control">
          <a
            href={`webcal://${window.location.host}/api/calendar/${token}`}
            className="btn btn-ghost"
          >
            <ExternalLink size={14} />
            Subscribe
          </a>
        </div>
      </div>
      <div className="sep" />
      <div className="settings-row">
        <div>
          <div className="settings-row-label">Copy feed URL</div>
          <div className="settings-row-hint">
            For Google Calendar: Other calendars → From URL. Google can take up to a day to refresh.
          </div>
        </div>
        <div className="settings-row-control">
          <button type="button" onClick={handleCopy} className="btn btn-ghost">
            <Copy size={14} />
            Copy
          </button>
        </div>
      </div>
      <div className="sep" />
      <div className="settings-row">
        <div>
          <div className="settings-row-label">Reset link</div>
          <div className="settings-row-hint">
            Anyone with this link can see your session schedule. Reset it to revoke old links.
          </div>
        </div>
        <div className="settings-row-control">
          <button
            type="button"
            onClick={handleReset}
            disabled={resetting}
            className="btn btn-ghost"
          >
            {resetting ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}

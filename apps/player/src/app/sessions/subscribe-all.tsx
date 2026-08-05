'use client';

import { useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { getCalendarFeedToken } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

// Subscribe to every session at once, rather than adding them one at a time.
//
// This deliberately hands over the EXISTING per-player ICS feed instead of
// generating a one-off multi-event .ics. A downloaded file is a snapshot: it
// goes stale the moment a session is added, moved or cancelled, and the member
// has no way to know. A subscription keeps itself right, and it is the same
// feed already offered in Settings — one source of truth, not two.
//
// The token is minted on CLICK, not on page load. It is a bearer credential for
// that member's schedule (calendar apps cannot log in, so the unguessable token
// IS the auth), and there is no reason to create one for everybody who merely
// opens the sessions page.
export function SubscribeAllButton() {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleClick() {
    setLoading(true);
    const res = await getCalendarFeedToken();
    setLoading(false);
    if (!res.ok) { toast(res.error, 'error'); return; }

    // webcal:// is what makes the calendar app offer to SUBSCRIBE rather than
    // import a copy. Same origin as the page, so this works on the club domain
    // and on localhost without a configured base URL.
    window.location.href = `webcal://${window.location.host}/api/calendar/${res.data}`;
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className="btn btn-ghost press"
      style={{ gap: 6, fontSize: 13 }}
      title="Subscribe in your calendar app — stays up to date as sessions change"
    >
      <CalendarPlus size={14} />
      {loading ? 'Opening…' : 'Add all to calendar'}
    </button>
  );
}

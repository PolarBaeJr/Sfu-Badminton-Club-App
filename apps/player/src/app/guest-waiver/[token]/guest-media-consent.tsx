'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { clubDate } from '@badminton/shared';
import { setGuestMediaConsent } from '@/lib/actions/guest-waiver';

// A guest's photo and video consent (00255), changed by whoever holds the
// proof link. One button: it offers the opposite of whatever is stored.
export function GuestMediaConsent({
  token,
  initialConsent,
  initialChangedAt,
}: {
  token: string;
  initialConsent: boolean;
  initialChangedAt: string | null;
}) {
  const [consent, setConsent] = useState(initialConsent);
  const [changedAt, setChangedAt] = useState(initialChangedAt);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleClick() {
    setLoading(true);
    setError('');
    try {
      const res = await setGuestMediaConsent({ token, media_consent: !consent });
      if (res.ok) {
        setConsent(res.data.consent);
        setChangedAt(res.data.changedAt);
      } else {
        setError(res.ref ? `${res.error} (reference ${res.code}.${res.ref})` : res.error);
      }
    } catch {
      setError('Your choice could not be sent. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
      <span>
        {consent ? 'Allowed' : 'Not allowed'}
        {changedAt && ` (changed ${clubDate(changedAt)})`}
      </span>
      <button type="button" onClick={handleClick} disabled={loading} className="btn btn-ghost">
        {loading && <Loader2 size={14} className="animate-spin" />}
        {consent ? 'Withdraw consent' : 'Allow photos and video'}
      </button>
      {error && <div className="alert-danger" role="alert">{error}</div>}
    </div>
  );
}

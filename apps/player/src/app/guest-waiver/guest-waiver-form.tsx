'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { clubDate } from '@badminton/shared';
import { signGuestWaiver, type GuestWaiverSigning } from '@/lib/actions/guest-waiver';

const LABEL_STYLE = { fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' } as const;
const CHECK_ROW_STYLE = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  fontSize: 13,
  lineHeight: 1.5,
  cursor: 'pointer',
} as const;
const CHECK_STYLE = { marginTop: 2, accentColor: 'var(--red)', flexShrink: 0 } as const;

export function GuestWaiverForm() {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [ofAge, setOfAge] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [signed, setSigned] = useState<GuestWaiverSigning | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await signGuestWaiver({
        full_name: fullName,
        email,
        age_attestation: ofAge,
        documents_accepted: accepted,
      });
      if (res.ok) setSigned(res.data);
      else setError(res.ref ? `${res.error} (reference ${res.code}.${res.ref})` : res.error);
    } catch {
      setError('Your signing could not be sent. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  if (signed) {
    const proof = `/guest-waiver/${signed.token}`;
    return (
      <section className="card-base" role="status" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>You have signed, {signed.full_name}</h2>
        <div style={{ fontSize: 14 }}>
          Signed {clubDate(signed.accepted_at)}. Liability Waiver version {signed.waiver_version}, Privacy Policy
          version {signed.privacy_version}.
        </div>
        <div className="signin-notice">
          Your proof of signing has its own page. Open it and bookmark it, or show it at the door:{' '}
          <Link href={proof}>Open your proof page</Link>
        </div>
      </section>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="card-base"
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <label htmlFor="guest-name" className="mono muted" style={LABEL_STYLE}>
        Full name
      </label>
      <input
        id="guest-name"
        type="text"
        autoComplete="name"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        required
        maxLength={100}
        className="input-base"
      />
      <label htmlFor="guest-email" className="mono muted" style={LABEL_STYLE}>
        Email
      </label>
      <input
        id="guest-email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        required
        maxLength={254}
        className="input-base"
      />

      <label htmlFor="guest-age" style={CHECK_ROW_STYLE}>
        <input
          id="guest-age"
          type="checkbox"
          checked={ofAge}
          onChange={(e) => setOfAge(e.target.checked)}
          required
          style={CHECK_STYLE}
        />
        <span>I am 19 or older.</span>
      </label>
      <div className="muted" style={{ fontSize: 12, marginTop: -6, paddingLeft: 23 }}>
        If you are under 19, please speak to a club executive before you play.
      </div>

      <label htmlFor="guest-accept" style={CHECK_ROW_STYLE}>
        <input
          id="guest-accept"
          type="checkbox"
          checked={accepted}
          onChange={(e) => setAccepted(e.target.checked)}
          required
          style={CHECK_STYLE}
        />
        <span>I have read and agree to the Liability Waiver and the Privacy Policy above.</span>
      </label>

      {error && <div className="alert-danger" role="alert">{error}</div>}
      <button type="submit" disabled={loading} className="btn btn-primary btn-lg signin-cta">
        {loading && <Loader2 size={16} className="animate-spin" />}
        Sign as a guest
      </button>
    </form>
  );
}

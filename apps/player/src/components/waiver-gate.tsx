'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LegalMarkdown } from '@badminton/ui';
import { LEGAL_DOCUMENT_LABELS, sortLegalDocuments } from '@badminton/shared';
import { Loader2 } from 'lucide-react';
import { getLegalDocuments, acceptLegalDocuments } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

// Paths where the gate must never render: the public routes from
// middleware.ts, plus /onboarding (which has its own waiver step).
function isExemptPath(pathname: string) {
  return (
    pathname === '/' ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/exec') ||
    pathname.startsWith('/legal') ||
    pathname === '/leaderboard' ||
    pathname.startsWith('/onboarding')
  );
}

// Full-screen, non-dismissable overlay shown to existing members with a
// missing/outdated legal-document acceptance — or an expired annual waiver.
// Only the missing documents are rendered and checked; valid acceptances for
// the others stay untouched (the server inserts rows only for the missing
// set). Intentionally NOT the @badminton/ui Dialog — that closes on
// Escape/backdrop click, and this gate must not.
export function WaiverGate({ missingDocs }: { missingDocs: string[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const { toast } = useToast();
  const [docs, setDocs] = useState<{ document: string; version: string; content: string }[] | null>(null);
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const [cocAccepted, setCocAccepted] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [ageAttested, setAgeAttested] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const active = missingDocs.length > 0 && !isExemptPath(pathname);

  useEffect(() => {
    if (!active || docs !== null) return;
    getLegalDocuments()
      .then(setDocs)
      .catch(() => toast('Failed to load the waiver — please refresh', 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (!active) return null;

  // Members who completed onboarding signed the waiver then, so a
  // waiver-only gap means the annual re-signature is due.
  const renewalOnly = missingDocs.length === 1 && missingDocs[0] === 'waiver';
  const needsWaiverBox = missingDocs.includes('waiver');
  const needsCocBox = missingDocs.includes('code_of_conduct');
  const needsTermsBox = missingDocs.includes('terms_of_use') || missingDocs.includes('privacy_policy');

  const allAccepted =
    (!needsWaiverBox || waiverAccepted) &&
    (!needsCocBox || cocAccepted) &&
    (!needsTermsBox || termsAccepted) &&
    ageAttested;

  const shownDocs = docs === null ? null : sortLegalDocuments(docs.filter((d) => missingDocs.includes(d.document)));

  async function handleAccept() {
    setSubmitting(true);
    try {
      // All four literals are asserted here; the server only inserts rows for
      // documents actually missing, so documents already validly accepted
      // keep their original acceptance evidence.
      await acceptLegalDocuments({
        waiver_accepted: true,
        code_of_conduct_accepted: true,
        terms_accepted: true,
        age_attestation: true,
      });
      toast('Thanks — you’re all set', 'success');
      // Deliberately stay in the submitting state: refresh() re-runs the
      // server layout, which recomputes the missing documents and unmounts
      // the gate.
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to record acceptance', 'error');
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Club legal documents"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'var(--bg-overlay)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        className="card-base"
        style={{ width: '100%', maxWidth: 640, maxHeight: '90vh', display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div>
          <div className="card-title card-title-lg">
            {renewalOnly ? 'Annual renewal' : 'Before you play'}
          </div>
          <div className="card-sub">
            {renewalOnly
              ? 'Your annual waiver renewal is due — please re-sign the liability waiver to keep using the app.'
              : "Please accept the club's legal documents below to keep using the app."}
          </div>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, border: '1px solid var(--line)', borderRadius: 10, padding: 14 }}>
          {shownDocs === null ? (
            <div className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <Loader2 size={14} className="animate-spin" /> Loading documents…
            </div>
          ) : (
            shownDocs.map((doc) => (
              <div key={doc.document} style={{ marginBottom: 18 }}>
                <div className="card-title">{LEGAL_DOCUMENT_LABELS[doc.document as keyof typeof LEGAL_DOCUMENT_LABELS] || doc.document}</div>
                <div className="card-sub mono">Version {doc.version}</div>
                <LegalMarkdown content={doc.content} />
              </div>
            ))
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {needsTermsBox && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, lineHeight: 1.5, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                style={{ marginTop: 2, accentColor: 'var(--red)', flexShrink: 0 }}
              />
              <span>I agree to the Terms of Use and Privacy Policy.</span>
            </label>
          )}
          {needsWaiverBox && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, lineHeight: 1.5, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={waiverAccepted}
                onChange={(e) => setWaiverAccepted(e.target.checked)}
                style={{ marginTop: 2, accentColor: 'var(--red)', flexShrink: 0 }}
              />
              <span>I have read and accept the liability waiver.</span>
            </label>
          )}
          {needsCocBox && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, lineHeight: 1.5, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={cocAccepted}
                onChange={(e) => setCocAccepted(e.target.checked)}
                style={{ marginTop: 2, accentColor: 'var(--red)', flexShrink: 0 }}
              />
              <span>I have read and accept the code of conduct.</span>
            </label>
          )}
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, lineHeight: 1.5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={ageAttested}
              onChange={(e) => setAgeAttested(e.target.checked)}
              style={{ marginTop: 2, accentColor: 'var(--red)', flexShrink: 0 }}
            />
            <span>I am 19 or older, or I have my parent/guardian&apos;s consent.</span>
          </label>
        </div>

        <button
          type="button"
          onClick={handleAccept}
          disabled={!allAccepted || submitting || docs === null}
          className="btn btn-primary btn-lg"
          style={{
            width: '100%',
            justifyContent: 'center',
            height: 48,
            opacity: allAccepted && !submitting && docs !== null ? 1 : 0.4,
          }}
        >
          {submitting ? <Loader2 size={16} className="animate-spin" /> : null}
          Accept and continue
        </button>
      </div>
    </div>
  );
}

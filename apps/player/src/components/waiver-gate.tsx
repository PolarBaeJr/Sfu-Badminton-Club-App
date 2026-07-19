'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LegalMarkdown } from '@badminton/ui';
import { Loader2 } from 'lucide-react';
import { getLegalDocuments, acceptLegalDocuments } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

const DOC_TITLES: Record<string, string> = {
  waiver: 'Liability Waiver & Assumption of Risk',
  code_of_conduct: 'Code of Conduct',
};

// Paths where the gate must never render: the public routes from
// middleware.ts, plus /onboarding (which has its own waiver step).
function isExemptPath(pathname: string) {
  return (
    pathname === '/' ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/exec') ||
    pathname === '/leaderboard' ||
    pathname.startsWith('/onboarding')
  );
}

// Full-screen, non-dismissable overlay shown to existing members who haven't
// accepted the current version of both legal documents. Intentionally NOT the
// @badminton/ui Dialog — that closes on Escape/backdrop click, and this gate
// must not.
export function WaiverGate({ needsWaiver }: { needsWaiver: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { toast } = useToast();
  const [docs, setDocs] = useState<{ document: string; version: string; content: string }[] | null>(null);
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const [cocAccepted, setCocAccepted] = useState(false);
  const [ageAttested, setAgeAttested] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const active = needsWaiver && !isExemptPath(pathname);

  useEffect(() => {
    if (!active || docs !== null) return;
    getLegalDocuments()
      .then(setDocs)
      .catch(() => toast('Failed to load the waiver — please refresh', 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (!active) return null;

  const allAccepted = waiverAccepted && cocAccepted && ageAttested;

  async function handleAccept() {
    setSubmitting(true);
    try {
      await acceptLegalDocuments({
        waiver_accepted: true,
        code_of_conduct_accepted: true,
        age_attestation: true,
      });
      toast('Thanks — you’re all set', 'success');
      // Deliberately stay in the submitting state: refresh() re-runs the
      // server layout, which recomputes needsWaiver and unmounts the gate.
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
      aria-label="Liability waiver and code of conduct"
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
          <div className="card-title card-title-lg">Before you play</div>
          <div className="card-sub">
            Please accept the club&apos;s liability waiver and code of conduct to keep using the app.
          </div>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, border: '1px solid var(--line)', borderRadius: 10, padding: 14 }}>
          {docs === null ? (
            <div className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <Loader2 size={14} className="animate-spin" /> Loading documents…
            </div>
          ) : (
            docs.map((doc) => (
              <div key={doc.document} style={{ marginBottom: 18 }}>
                <div className="card-title">{DOC_TITLES[doc.document] || doc.document}</div>
                <div className="card-sub mono">Version {doc.version}</div>
                <LegalMarkdown content={doc.content} />
              </div>
            ))
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, lineHeight: 1.5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={waiverAccepted}
              onChange={(e) => setWaiverAccepted(e.target.checked)}
              style={{ marginTop: 2, accentColor: 'var(--red)', flexShrink: 0 }}
            />
            <span>I have read and accept the liability waiver.</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, lineHeight: 1.5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={cocAccepted}
              onChange={(e) => setCocAccepted(e.target.checked)}
              style={{ marginTop: 2, accentColor: 'var(--red)', flexShrink: 0 }}
            />
            <span>I have read and accept the code of conduct.</span>
          </label>
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

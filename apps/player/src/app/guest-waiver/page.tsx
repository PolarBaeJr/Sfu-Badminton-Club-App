import { PageHeader, LegalMarkdown } from '@badminton/ui';
import { LEGAL_DOCUMENT_LABELS, clubDate, type WaiverDocument } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { FeatureGate } from '@/lib/feature-gate';
import { GuestWaiverForm } from './guest-waiver-form';

// Public page (see public-paths.ts): a non-member signs the waiver and the
// privacy policy with a name and an email, and no account.
//
// GATED HERE, NOT IN A LAYOUT, so the proof pages under /guest-waiver/<token>
// keep working after the switch goes off. The documents are read inside the
// gate, so a switched-off page reads nothing.
export const dynamic = 'force-dynamic';

const DOCUMENTS: WaiverDocument[] = ['waiver', 'privacy_policy'];

export default function GuestWaiverPage() {
  return (
    <FeatureGate feature="guest_waivers">
      <GuestWaiverBody />
    </FeatureGate>
  );
}

async function GuestWaiverBody() {
  // Service role: the legal_documents SELECT policy is authenticated-only.
  // Same reasoning as legal/[doc]/page.tsx.
  const { data: rows, error } = await createServiceRoleClient()
    .from('legal_documents')
    .select('document, version, content, updated_at')
    .in('document', DOCUMENTS);
  if (error) console.error('[guest-waiver] could not read the legal documents:', error.message);
  const byDocument = new Map((rows ?? []).map((r) => [r.document as WaiverDocument, r]));
  const available = DOCUMENTS.every((d) => byDocument.has(d));

  return (
    <div data-screen-label="Guest waiver" style={{ maxWidth: 760, margin: '0 auto' }}>
      <PageHeader
        eyebrow="PLAYING AS A GUEST"
        title="Guest waiver"
        sub="Not a member? Read and sign these before you play. No account needed."
      />
      {available ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {DOCUMENTS.map((d) => {
            const row = byDocument.get(d)!;
            return (
              <section key={d} className="card-base">
                <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{LEGAL_DOCUMENT_LABELS[d]}</h2>
                <div className="muted" style={{ fontSize: 13, margin: '4px 0 12px' }}>
                  Version {row.version}, updated {clubDate(row.updated_at)}
                </div>
                <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                  <LegalMarkdown content={row.content} />
                </div>
              </section>
            );
          })}
          <GuestWaiverForm />
        </div>
      ) : (
        <div className="card-base" role="status">
          The guest waiver is not available right now. Please try again later, or speak to a club executive.
        </div>
      )}
    </div>
  );
}

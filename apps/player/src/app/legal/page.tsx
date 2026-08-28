import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { PageHeader } from '@badminton/ui';
import {
  LEGAL_DOCUMENT_ORDER,
  LEGAL_DOCUMENT_LABELS,
  LEGAL_DOCUMENT_SLUGS,
  formatDate,
  type WaiverDocument,
} from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';

// Public page — viewable without an account (see middleware public allowlist).
export const dynamic = 'force-dynamic';

// One line each, saying what the document actually governs. The documents
// themselves open with their own preamble; this is the sentence that helps
// someone pick which one they came for.
const BLURBS: Record<WaiverDocument, string> = {
  terms_of_use: 'What you agree to by using the club app and booking sessions.',
  privacy_policy: 'What we collect, why we keep it, and how long we keep it for.',
  waiver: 'The risks of playing and what you assume by taking the court.',
  code_of_conduct: 'How members are expected to treat each other, on court and off.',
};

export default async function LegalIndexPage() {
  // Service role: the legal_documents SELECT policy is authenticated-only, but
  // these documents are public reading. Same reasoning as [doc]/page.tsx.
  const supabase = createServiceRoleClient();
  const { data: rows } = await supabase
    .from('legal_documents')
    .select('document, version, updated_at');

  // Drive the list from LEGAL_DOCUMENT_ORDER rather than from the query, so a
  // document that has no row yet is simply absent instead of reordering the
  // rest — and so the order matches the waiver gate and onboarding.
  const byDocument = new Map((rows ?? []).map((r) => [r.document, r]));
  const documents = LEGAL_DOCUMENT_ORDER.filter((d) => byDocument.has(d));

  return (
    <div data-screen-label="Legal" style={{ maxWidth: 760, margin: '0 auto' }}>
      <PageHeader
        eyebrow="CLUB LEGAL"
        title="Club documents"
        sub="The terms, policies and waivers that govern club membership."
      />
      <div className="grid" style={{ gap: 12 }}>
        {documents.map((document) => {
          const row = byDocument.get(document)!;
          return (
            <Link
              key={document}
              href={`/legal/${LEGAL_DOCUMENT_SLUGS[document]}`}
              className="card-base card-interactive"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                textDecoration: 'none',
                color: 'inherit',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{LEGAL_DOCUMENT_LABELS[document]}</div>
                <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                  {BLURBS[document]}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  Version {row.version} · updated {formatDate(row.updated_at)}
                </div>
              </div>
              <ChevronRight size={16} className="text-[var(--mute)]" style={{ marginLeft: 'auto', flexShrink: 0 }} />
            </Link>
          );
        })}
      </div>
    </div>
  );
}

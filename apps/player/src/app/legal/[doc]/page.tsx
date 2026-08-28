import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { PageHeader, LegalMarkdown } from '@badminton/ui';
import {
  LEGAL_DOCUMENT_LABELS,
  SLUG_TO_LEGAL_DOCUMENT,
  formatDate,
} from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';

// Public page — viewable without an account (see middleware public allowlist).
export const dynamic = 'force-dynamic';

export default async function LegalDocumentPage({
  params,
}: {
  params: Promise<{ doc: string }>;
}) {
  const { doc } = await params;
  const document = SLUG_TO_LEGAL_DOCUMENT[doc];
  if (!document) notFound();

  // Service role: the legal_documents SELECT policy is authenticated-only,
  // but these documents are public reading.
  const supabase = createServiceRoleClient();
  const { data: row } = await supabase
    .from('legal_documents')
    .select('document, version, content, updated_at')
    .eq('document', document)
    .maybeSingle();
  if (!row) notFound();

  return (
    <div data-screen-label="Legal" style={{ maxWidth: 760, margin: '0 auto' }}>
      <Link
        href="/legal"
        className="muted"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 13,
          textDecoration: 'none',
          marginBottom: 12,
        }}
      >
        <ChevronLeft size={14} /> All club documents
      </Link>
      <PageHeader
        eyebrow="CLUB LEGAL"
        title={LEGAL_DOCUMENT_LABELS[document]}
        sub={`Version ${row.version} · updated ${formatDate(row.updated_at)}`}
      />
      <div className="card-base">
        <LegalMarkdown content={row.content} />
      </div>
    </div>
  );
}

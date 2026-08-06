export const dynamic = 'force-dynamic';
import { createAdminClient, getAuthenticatedExecOrAdmin } from '@/lib/supabase-server';
import { PageHeader } from '@badminton/ui';
import { sortLegalDocuments } from '@badminton/shared';
import { accessLevelFor } from '@/lib/permissions';
import { LegalDocumentsForm } from './legal-documents-form';

// Its own section rather than a block inside Settings, because two different
// audiences need it: an admin editing the text, and an exec who needs to read
// what members agreed to — or make everyone re-sign before an event.
//
// Reachable at exec level (permissions.ts). Editing is admin-only, enforced in
// updateLegalDocument(); requiring a re-signature is exec-level, enforced in
// requireReacceptance(). The canEdit flag below only decides which controls are
// offered — it is not the boundary.
export default async function LegalPage() {
  const viewer = await getAuthenticatedExecOrAdmin();
  const canEdit = accessLevelFor(viewer) === 'admin';

  const { data: legalDocuments } = await createAdminClient()
    .from('legal_documents')
    .select('document, version, content, updated_at');
  const documents = sortLegalDocuments(legalDocuments ?? []);

  return (
    <div>
      <PageHeader
        title="Legal"
        sub={
          canEdit
            ? 'Terms, privacy, waiver and code of conduct — shown to every member during onboarding'
            : 'Terms, privacy, waiver and code of conduct — read-only. You can require members to re-sign.'
        }
        watermark="L"
      />

      <div className="card-base">
        <p className="settings-section-desc">
          {canEdit ? (
            <>
              Bumping a version forces every member to re-accept before playing.
              &ldquo;Require re-signature now&rdquo; does the same without changing the text.
            </>
          ) : (
            <>
              Only an admin can change these documents. You can require every member to
              re-sign one on their next visit — useful before a tournament or a new term.
            </>
          )}
        </p>
        <LegalDocumentsForm documents={documents} canEdit={canEdit} />
      </div>
    </div>
  );
}

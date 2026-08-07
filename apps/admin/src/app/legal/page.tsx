export const dynamic = 'force-dynamic';
import { createAdminClient, getAuthenticatedExecOrAdmin } from '@/lib/supabase-server';
import { PageHeader } from '@badminton/ui';
import { sortLegalDocuments } from '@badminton/shared';
import { accessLevelFor } from '@/lib/permissions';
import { LegalDocumentsForm } from './legal-documents-form';
import { EventWaiverTemplateForm } from './event-waiver-template-form';

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

  const adminClient = createAdminClient();
  const { data: legalDocuments } = await adminClient
    .from('legal_documents')
    .select('document, version, content, updated_at');
  const documents = sortLegalDocuments(legalDocuments ?? []);

  // Event-waiver templates are per season (00074) and are NOT legal_documents
  // rows — that table is the list of things every member must accept, and a
  // fifth row in it would block the whole club out of the player app.
  // Newest season first: the one being drafted for is almost always the target.
  const [{ data: seasons }, { data: waiverTemplates }] = await Promise.all([
    adminClient
      .from('seasons')
      .select('id, name, active_flag')
      .order('year', { ascending: false })
      .order('term', { ascending: false }),
    adminClient.from('event_waiver_templates').select('season_id, content, updated_at'),
  ]);

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

      {/* Its own card, below the four documents, because it is a different kind
          of thing: nobody accepts this text as-is. It is the wording a
          tournament's own event waiver starts from. */}
      <div className="card-base mt-6">
        <p className="settings-section-desc">
          The event waiver a tournament starts from, kept per season so each term&rsquo;s
          venue and club terms can differ.{' '}
          {canEdit
            ? 'Execs pull it into an event when they create a tournament.'
            : 'Only an admin can change this text. You can use it when you create a tournament.'}
        </p>
        <EventWaiverTemplateForm
          seasons={seasons ?? []}
          templates={waiverTemplates ?? []}
          canEdit={canEdit}
        />
      </div>
    </div>
  );
}

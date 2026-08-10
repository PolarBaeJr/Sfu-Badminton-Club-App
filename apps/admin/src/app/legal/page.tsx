export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { PageHeader } from '@badminton/ui';
import { sortLegalDocuments } from '@badminton/shared';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import { LegalDocumentsForm } from './legal-documents-form';
import { EventWaiverTemplateForm } from './event-waiver-template-form';

// Its own section rather than a block inside Settings, because two different
// audiences need it: an admin editing the text, and an exec who needs to read
// what members agreed to — or make everyone re-sign before an event.
//
// legal.read is what opens the section, and an exec holds it. Editing asks for
// legal.documents.write and legal.waivertemplate.write, which no baseline below
// admin holds; requiring a re-signature asks for legal.reacceptance.write, which
// every exec holds. The flags below only decide which controls are offered —
// the server actions are the boundary.
export default async function LegalPage() {
  const viewer = await requireCapability('legal.read');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(viewer);
  const canEdit = permits(level, permissions, 'legal.documents.write');
  // THE THIRD CONTROL ON THIS PAGE, and until now the only one nobody asked a
  // question about. "Require re-signature now" was rendered for every viewer,
  // which was right while every viewer was an exec or an admin and every exec
  // held legal.reacceptance.write. It is not a control that can stay
  // unconditional once somebody can hold legal.read alone — forcing the whole
  // club to re-sign a document is the loudest thing this page does, and it
  // would have been the one control a read-only holder was still offered.
  const canRequireReacceptance = permits(level, permissions, 'legal.reacceptance.write');
  // Editing the event-waiver template is its own capability, not a second
  // reading of canEdit: they sit in the same baseline today, and nothing but
  // this line would keep them apart the day one is handed out alone.
  const canEditWaiverTemplate = permits(level, permissions, 'legal.waivertemplate.write');

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
            : canRequireReacceptance
              ? 'Terms, privacy, waiver and code of conduct — read-only. You can require members to re-sign.'
              : 'Terms, privacy, waiver and code of conduct — read-only.'
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
          ) : canRequireReacceptance ? (
            <>
              Only an admin can change these documents. You can require every member to
              re-sign one on their next visit — useful before a tournament or a new term.
            </>
          ) : (
            <>Only an admin can change these documents. This is what members have agreed to.</>
          )}
        </p>
        <LegalDocumentsForm
          documents={documents}
          canEdit={canEdit}
          canRequireReacceptance={canRequireReacceptance}
        />
      </div>

      {/* Its own card, below the four documents, because it is a different kind
          of thing: nobody accepts this text as-is. It is the wording a
          tournament's own event waiver starts from. */}
      <div className="card-base mt-6">
        <p className="settings-section-desc">
          The event waiver a tournament starts from, kept per season so each term&rsquo;s
          venue and club terms can differ.{' '}
          {canEditWaiverTemplate
            ? 'Execs pull it into an event when they create a tournament.'
            : 'Only an admin can change this text. You can use it when you create a tournament.'}
        </p>
        <EventWaiverTemplateForm
          seasons={seasons ?? []}
          templates={waiverTemplates ?? []}
          canEdit={canEditWaiverTemplate}
        />
      </div>
    </div>
  );
}

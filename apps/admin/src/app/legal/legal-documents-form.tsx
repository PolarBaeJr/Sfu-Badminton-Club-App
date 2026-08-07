'use client';

import { useState } from 'react';
import { Button, useConfirm } from '@badminton/ui';
import { LEGAL_DOCUMENT_LABELS, type WaiverDocument } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { updateLegalDocument, requireReacceptance } from '@/lib/actions';
import { AutoGrowTextarea } from './auto-grow-textarea';

interface LegalDocumentRow {
  document: string;
  version: string;
  content: string;
  updated_at: string;
}

const DOC_DESCRIPTIONS: Record<string, string> = {
  terms_of_use: 'App usage rules. Accepted during onboarding; public at /legal/terms. Markdown: ## headings, - lists, **bold**.',
  privacy_policy: 'What we collect and how long we keep it. Public at /legal/privacy. Markdown: ## headings, - lists, **bold**.',
  waiver: 'Shown to every member during onboarding, after a version bump, and re-signed annually. Markdown: ## headings, - lists, **bold**.',
  code_of_conduct: 'Accepted alongside the waiver. Markdown: ## headings, - lists, **bold**.',
};

export function LegalDocumentsForm({
  documents,
  canEdit,
}: {
  documents: LegalDocumentRow[];
  // Execs see the documents and may require a re-signature; only admins edit
  // the text. The server actions enforce this independently — hiding the
  // editor is so nobody is offered a control that will reject them.
  canEdit: boolean;
}) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const { toast } = useToast();
  const confirm = useConfirm();

  async function handleSave(doc: LegalDocumentRow, bumpVersion: boolean) {
    const content = edits[doc.document] ?? doc.content;
    setSaving(`${doc.document}${bumpVersion ? '-bump' : ''}`);
    try {
      await updateLegalDocument({
        document: doc.document as WaiverDocument,
        content,
        bump_version: bumpVersion,
      });
      toast(
        bumpVersion
          ? 'Saved — all members must re-accept before playing'
          : 'Saved',
        'success'
      );
      setEdits((prev) => {
        const next = { ...prev };
        delete next[doc.document];
        return next;
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save document', 'error');
    }
    setSaving(null);
  }

  async function handleRequireReacceptance(doc: LegalDocumentRow) {
    if (!(await confirm({ title: 'Require re-signature?', message: <>Require every member to re-sign <span className="text-[var(--text-primary)] font-medium">{LEGAL_DOCUMENT_LABELS[doc.document as WaiverDocument] || doc.document}</span> on their next visit? This does not change the document text.</>, confirmLabel: 'Require re-signature' }))) return;
    setSaving(`${doc.document}-reaccept`);
    try {
      await requireReacceptance(doc.document as WaiverDocument);
      toast('All members must re-sign this on their next visit.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to require re-signature', 'error');
    }
    setSaving(null);
  }

  return (
    <div>
      {documents.map((doc) => {
        const currentValue = edits[doc.document] ?? doc.content;
        const isEdited = doc.document in edits && edits[doc.document] !== doc.content;

        return (
          <div key={doc.document} className="settings-row !items-start">
            <div className="md:w-[220px] flex-shrink-0">
              <div className="settings-row-label">
                {LEGAL_DOCUMENT_LABELS[doc.document as WaiverDocument] || doc.document}
                {isEdited && (
                  <span className="ml-2 text-[var(--color-accent)]">Modified</span>
                )}
              </div>
              <div className="settings-row-hint">{DOC_DESCRIPTIONS[doc.document] || ''}</div>
              <p className="font-mono text-xs text-[var(--text-muted)] mt-2">
                version {doc.version} · updated {new Date(doc.updated_at).toLocaleDateString()}
              </p>
            </div>
            <div className="settings-row-control wide">
              {canEdit ? (
                /* rows={18} is only the floor — AutoGrowTextarea sizes the box
                   to the whole document on mount and on every keystroke, so
                   the page scrolls rather than the editor. */
                <AutoGrowTextarea
                  value={currentValue}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [doc.document]: e.target.value }))}
                  rows={18}
                  className="font-mono text-xs"
                />
              ) : (
                /* Read-only for execs. A disabled Textarea would look like an
                   editor that is merely switched off; a pre block reads as the
                   document it is. Same monospace so the two views match.
                   No max-height: an exec reading what members agreed to should
                   scroll the page, the same as the admin editing it. */
                <pre className="font-mono text-xs whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3 text-[var(--text-secondary)]">
                  {doc.content}
                </pre>
              )}
              <div className="flex items-center justify-end gap-2 mt-3">
                {canEdit && (
                <Button
                  variant="secondary"
                  onClick={() => handleSave(doc, false)}
                  loading={saving === doc.document}
                  disabled={saving !== null}
                >
                  Save
                </Button>
                )}
                {canEdit && (
                <Button
                  variant="ghost"
                  className="border-[var(--red-border)] text-[var(--color-accent)] hover:bg-[var(--red-wash)] hover:text-[var(--color-accent)]"
                  onClick={() => handleSave(doc, true)}
                  loading={saving === `${doc.document}-bump`}
                  disabled={saving !== null}
                >
                  Save &amp; require re-acceptance
                </Button>
                )}
                <Button
                  variant="ghost"
                  className="border-[var(--red-border)] text-[var(--color-accent)] hover:bg-[var(--red-wash)] hover:text-[var(--color-accent)]"
                  onClick={() => handleRequireReacceptance(doc)}
                  loading={saving === `${doc.document}-reaccept`}
                  disabled={saving !== null}
                >
                  Require re-signature now
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Button, Card, Textarea } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { updateLegalDocument } from '@/lib/actions';

interface LegalDocumentRow {
  document: string;
  version: string;
  content: string;
  updated_at: string;
}

const DOC_LABELS: Record<string, string> = {
  waiver: 'Liability Waiver & Assumption of Risk',
  code_of_conduct: 'Code of Conduct',
};

const DOC_DESCRIPTIONS: Record<string, string> = {
  waiver: 'Shown to every member during onboarding and after a version bump. Markdown: ## headings, - lists, **bold**.',
  code_of_conduct: 'Accepted alongside the waiver. Markdown: ## headings, - lists, **bold**.',
};

export function LegalDocumentsForm({ documents }: { documents: LegalDocumentRow[] }) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const { toast } = useToast();

  async function handleSave(doc: LegalDocumentRow, bumpVersion: boolean) {
    const content = edits[doc.document] ?? doc.content;
    setSaving(`${doc.document}${bumpVersion ? '-bump' : ''}`);
    try {
      await updateLegalDocument({
        document: doc.document as 'waiver' | 'code_of_conduct',
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

  return (
    <div className="space-y-4">
      {documents.map((doc) => {
        const currentValue = edits[doc.document] ?? doc.content;
        const isEdited = doc.document in edits && edits[doc.document] !== doc.content;

        return (
          <Card key={doc.document} className={isEdited ? 'border-[var(--color-accent)]/50' : ''}>
            <div className="flex items-start justify-between mb-2">
              <div>
                <h3 className="text-[var(--text-primary)] font-medium">{DOC_LABELS[doc.document] || doc.document}</h3>
                <p className="text-xs text-[var(--text-muted)]">{DOC_DESCRIPTIONS[doc.document] || ''}</p>
              </div>
              {isEdited && (
                <span className="text-xs text-[var(--color-accent)]">Modified</span>
              )}
            </div>
            <Textarea
              value={currentValue}
              onChange={(e) => setEdits((prev) => ({ ...prev, [doc.document]: e.target.value }))}
              rows={18}
              className="font-mono text-xs"
            />
            <div className="flex items-center justify-between mt-3">
              <p className="font-mono text-xs text-[var(--text-muted)]">
                version {doc.version} · updated {new Date(doc.updated_at).toLocaleDateString()}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => handleSave(doc, false)}
                  loading={saving === doc.document}
                  disabled={saving !== null}
                >
                  Save
                </Button>
                <Button
                  onClick={() => handleSave(doc, true)}
                  loading={saving === `${doc.document}-bump`}
                  disabled={saving !== null}
                >
                  Save &amp; require re-acceptance
                </Button>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

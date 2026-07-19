'use client';

import { useState } from 'react';
import { Button, Textarea } from '@badminton/ui';
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

/** Auto-grow the textarea with its content, capped at ~60vh (page scrolls past that). */
function autoGrow(e: React.FormEvent<HTMLTextAreaElement>) {
  const el = e.currentTarget;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.6)}px`;
}

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
    <div>
      {documents.map((doc) => {
        const currentValue = edits[doc.document] ?? doc.content;
        const isEdited = doc.document in edits && edits[doc.document] !== doc.content;

        return (
          <div key={doc.document} className="settings-row !items-start">
            <div className="md:w-[220px] flex-shrink-0">
              <div className="settings-row-label">
                {DOC_LABELS[doc.document] || doc.document}
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
              <Textarea
                value={currentValue}
                onChange={(e) => setEdits((prev) => ({ ...prev, [doc.document]: e.target.value }))}
                onInput={autoGrow}
                rows={18}
                className="font-mono text-xs"
              />
              <div className="flex items-center justify-end gap-2 mt-3">
                <Button
                  variant="secondary"
                  onClick={() => handleSave(doc, false)}
                  loading={saving === doc.document}
                  disabled={saving !== null}
                >
                  Save
                </Button>
                <Button
                  variant="ghost"
                  className="border-[var(--red-border)] text-[var(--color-accent)] hover:bg-[var(--red-wash)] hover:text-[var(--color-accent)]"
                  onClick={() => handleSave(doc, true)}
                  loading={saving === `${doc.document}-bump`}
                  disabled={saving !== null}
                >
                  Save &amp; require re-acceptance
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

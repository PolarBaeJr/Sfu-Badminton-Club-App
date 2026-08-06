'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, legalDocumentUpdateSchema, waiverDocumentSchema, type LegalDocumentUpdateInput, type WaiverDocument } from '@badminton/shared';
import { getAdminPlayer, getExecOrAdmin } from './_shared';

// Bumping re-requires acceptance from every member (the player app compares
// accepted versions against the current one). Versions are date strings; a
// same-day second bump appends '.2', '.3', ... so the string still changes.
function nextVersion(oldVersion: string): string {
  const today = new Date().toISOString().split('T')[0]!;
  if (oldVersion === today) return `${today}.2`;
  const sameDay = oldVersion.match(new RegExp(`^${today}\\.(\\d+)$`));
  if (sameDay) return `${today}.${Number(sameDay[1]) + 1}`;
  return today;
}

export async function updateLegalDocument(input: LegalDocumentUpdateInput) {
  parseOrThrow(legalDocumentUpdateSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: old, error: readError } = await adminClient
    .from('legal_documents')
    .select('version, content')
    .eq('document', input.document)
    .single();
  if (readError) throw new Error(readError.message);

  const newVersion = input.bump_version ? nextVersion(old.version) : old.version;

  const { error } = await adminClient
    .from('legal_documents')
    .update({
      content: input.content,
      version: newVersion,
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    })
    .eq('document', input.document);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'legal_document_updated',
    target_type: 'legal_document',
    target_id: input.document,
    old_value: { version: old.version, content_length: old.content.length },
    new_value: { version: newVersion, content_length: input.content.length },
    reason: input.bump_version
      ? `Legal document "${input.document}" updated with version bump (re-acceptance required)`
      : `Legal document "${input.document}" content updated`,
  });

  revalidatePath('/settings');
}

// Force every member to re-sign a specific document on their next visit,
// without editing its text or bumping its version. Stamps
// reacceptance_required_since = now(); the shared getMissingLegalDocuments
// helper then treats any acceptance older than this as stale.
// Exec-level on purpose: re-running the consent flow is operational — "everyone
// re-sign before the tournament" — and it cannot change what anyone is agreeing
// to. Editing the TEXT stays admin-only, which is where the legal exposure is.
export async function requireReacceptance(document: WaiverDocument) {
  parseOrThrow(waiverDocumentSchema, document);
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: old, error: readError } = await adminClient
    .from('legal_documents')
    .select('reacceptance_required_since')
    .eq('document', document)
    .single();
  if (readError) throw new Error(readError.message);

  const now = new Date().toISOString();
  const { error } = await adminClient
    .from('legal_documents')
    .update({ reacceptance_required_since: now })
    .eq('document', document);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'legal_document_reacceptance_required',
    target_type: 'legal_document',
    target_id: document,
    old_value: { reacceptance_required_since: old.reacceptance_required_since },
    new_value: { reacceptance_required_since: now },
    reason: `All members must re-sign "${document}" on their next visit`,
  });

  revalidatePath('/settings');
}

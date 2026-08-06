'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, legalDocumentUpdateSchema, waiverDocumentSchema, type LegalDocumentUpdateInput, type WaiverDocument } from '@badminton/shared';
import { getAdminPlayer, getExecOrAdmin } from './_shared';

// Platform configuration. Admin-only, and this is the boundary that matters:
// /ratings and /accounts merely decide who is shown the form.
export async function updatePlatformSettings(
  updates: { key: string; value: Record<string, unknown> }[]
) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  for (const update of updates) {
    const { data: oldSetting } = await adminClient
      .from('platform_settings')
      .select('value')
      .eq('key', update.key)
      .single();

    const { error } = await adminClient
      .from('platform_settings')
      .update({
        value: update.value,
        updated_by: admin.id,
        updated_at: new Date().toISOString(),
      })
      .eq('key', update.key);

    if (error) throw new Error(`Failed to update ${update.key}: ${error.message}`);

    // Via logAdminAudit, not a bare insert: it checks the error and reports to
    // Sentry. The bare insert this replaced passed update.key into the `uuid`
    // target_id column and ignored the result, so every settings change since
    // launch went unaudited without a single symptom.
    await logAdminAudit(adminClient, {
      actor_id: admin.id,
      action_type: 'platform_setting_updated',
      target_type: 'platform_setting',
      target_id: null,
      old_value: oldSetting?.value ?? null,
      new_value: update.value,
      // Key FIRST. With target_id null this is the only place it appears, and
      // the /audit table truncates the reason cell at max-w-xs — "Platform
      // setting "repeat_opponent_caps" updated" is cut before the key ends.
      reason: `${update.key} — platform setting updated`,
    });
  }

  // The form now lives on /ratings and /accounts, not /settings.
  revalidatePath('/ratings');
  revalidatePath('/accounts');
}

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
    // Keyed by `document`, not a uuid — see logAdminAudit. Passing the document
    // name here made this insert fail too, silently, since Legal shipped.
    target_id: null,
    old_value: { version: old.version, content_length: old.content.length },
    new_value: { version: newVersion, content_length: input.content.length },
    // Document first, same reason as above.
    reason: input.bump_version
      ? `${input.document} — legal document updated, version bumped (re-acceptance required)`
      : `${input.document} — legal document content updated`,
  });

  // Left over from when the documents were a block inside /settings.
  revalidatePath('/legal');
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
    target_id: null,
    old_value: { reacceptance_required_since: old.reacceptance_required_since },
    new_value: { reacceptance_required_since: now },
    reason: `${document} — all members must re-sign on their next visit`,
  });

  revalidatePath('/legal');
}

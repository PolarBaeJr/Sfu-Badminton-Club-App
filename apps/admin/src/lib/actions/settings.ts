'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, legalDocumentUpdateSchema, waiverDocumentSchema, eventWaiverTemplateUpdateSchema, type LegalDocumentUpdateInput, type EventWaiverTemplateUpdateInput, type WaiverDocument } from '@badminton/shared';
import { requireCapability } from './_shared';
import { MIN_REASON_LENGTH } from '../legal-reason';

// Platform configuration. Admin-only, and this is the boundary that matters:
// /ratings and /accounts merely decide who is shown the form.
export async function updatePlatformSettings(
  updates: { key: string; value: Record<string, unknown> }[]
) {
  const admin = await requireCapability('platform.settings.write');
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

// The typed reason arrives as a SECOND PARAMETER rather than a field on
// `input`. legalDocumentUpdateSchema lives in @badminton/shared and is pinned
// by its own tests; the console's requirement that every audited action carry a
// reason is an admin-app rule, so it is enforced here, where the audit row is
// written. Validated server-side and not merely on the client: a reason the
// client gates on but the server never stores is the exact failure the rule
// exists to prevent — the audit row would still read as boilerplate.
function requireReason(reason: string | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < MIN_REASON_LENGTH) {
    throw new Error(`A reason of at least ${MIN_REASON_LENGTH} characters is required`);
  }
  return trimmed;
}

export async function updateLegalDocument(input: LegalDocumentUpdateInput, reason: string) {
  parseOrThrow(legalDocumentUpdateSchema, input);
  const auditReason = requireReason(reason);
  const admin = await requireCapability('legal.documents.write');
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
    // Document first, same reason as above. The editor's own words are kept
    // verbatim after the machine-written summary: the summary says what the
    // action did, and only the typed half says why.
    reason: input.bump_version
      ? `${input.document} — legal document updated, version bumped (re-acceptance required): ${auditReason}`
      : `${input.document} — legal document content updated: ${auditReason}`,
  });

  // Left over from when the documents were a block inside /settings.
  revalidatePath('/legal');
}

// Save a season's event-waiver template (00074) — the text an exec pulls into
// a new tournament's "Event waiver" box instead of retyping it.
//
// legal.waivertemplate.write, which no baseline below admin holds: this is
// legal text, and it is the same boundary updateLegalDocument() draws — note
// that the third gate in this file, requireReacceptance(), belongs to `legal`
// too and IS exec work, so the area here does not follow the file. Execs read
// it on /legal and copy
// it into an event; only an admin changes the wording. There is deliberately
// no requireReacceptance() counterpart — nobody accepts a template. Editing it
// cannot reach anyone who has already signed, because a tournament holds its
// own copy of the text (see the migration header).
export async function updateEventWaiverTemplate(input: EventWaiverTemplateUpdateInput) {
  parseOrThrow(eventWaiverTemplateUpdateSchema, input);
  const admin = await requireCapability('legal.waivertemplate.write');
  const adminClient = createAdminClient();

  // maybeSingle, not single: a season with no template yet is the normal first
  // save, not an error. Only the active season is seeded.
  const { data: old, error: readError } = await adminClient
    .from('event_waiver_templates')
    .select('content')
    .eq('season_id', input.season_id)
    .maybeSingle();
  if (readError) throw new Error(readError.message);

  const { data: saved, error } = await adminClient
    .from('event_waiver_templates')
    .upsert(
      {
        season_id: input.season_id,
        content: input.content,
        updated_at: new Date().toISOString(),
        updated_by: admin.id,
      },
      { onConflict: 'season_id' }
    )
    .select('season_id');
  if (error) throw new Error(error.message);
  // PostgREST reports "matched no rows" as a success with an empty body, so a
  // missing error proves nothing was rejected — not that anything was written.
  // Without this, a season_id that no longer exists (or an upsert silently
  // filtered away) would toast "Saved" over an unchanged template.
  if (!saved || saved.length !== 1) {
    throw new Error('Template was not saved — the season may no longer exist');
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'event_waiver_template_updated',
    target_type: 'event_waiver_template',
    // A real uuid here, unlike the legal_documents entries above: this table is
    // keyed by season_id, which is the seasons.id uuid.
    target_id: input.season_id,
    old_value: { content_length: old?.content.length ?? null },
    new_value: { content_length: input.content.length },
    reason: old
      ? 'event waiver template updated for a season'
      : 'event waiver template created for a season',
  });

  revalidatePath('/legal');
  // The create/edit tournament dialog is pre-filled from these rows.
  revalidatePath('/tournaments');
}

// Force every member to re-sign a specific document on their next visit,
// without editing its text or bumping its version. Stamps
// reacceptance_required_since = now(); the shared getMissingLegalDocuments
// helper then treats any acceptance older than this as stale.
// Exec-level on purpose: re-running the consent flow is operational — "everyone
// re-sign before the tournament" — and it cannot change what anyone is agreeing
// to. Editing the TEXT stays admin-only, which is where the legal exposure is.
export async function requireReacceptance(document: WaiverDocument, reason: string) {
  parseOrThrow(waiverDocumentSchema, document);
  const auditReason = requireReason(reason);
  const admin = await requireCapability('legal.reacceptance.write');
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
    reason: `${document} — all members must re-sign on their next visit: ${auditReason}`,
  });

  revalidatePath('/legal');
}

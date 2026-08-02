// Audit log helpers. NOT a 'use server' module — these are internal
// utilities imported by the admin server actions, not actions themselves.
import * as Sentry from '@sentry/nextjs';
import type { createAdminClient } from './supabase-server';

// Tournament-scoped audit trail (tournament_audit_log table).
export async function logAudit(
  adminClient: ReturnType<typeof createAdminClient>,
  params: {
    tournament_id?: string;
    event_id?: string;
    match_id?: string;
    action: string;
    performed_by: string;
    details?: Record<string, unknown>;
  }
) {
  await adminClient.from('tournament_audit_log').insert({
    tournament_id: params.tournament_id ?? null,
    event_id: params.event_id ?? null,
    match_id: params.match_id ?? null,
    action: params.action,
    performed_by: params.performed_by,
    details: params.details ?? null,
  });
}

// General admin audit trail (audit_logs table). A failed write is reported
// to Sentry but never breaks the parent action.
export async function logAdminAudit(
  adminClient: ReturnType<typeof createAdminClient>,
  entry: {
    // Null when the actor is a scheduled job rather than a person.
    actor_id: string | null;
    action_type: string;
    target_type: string;
    target_id: string;
    old_value?: unknown;
    new_value?: unknown;
    reason?: string;
  },
  sentryExtra: Record<string, unknown> = {}
) {
  const { error } = await adminClient.from('audit_logs').insert(entry);
  if (error) {
    Sentry.captureException(new Error(`Audit log write failed: ${error.message}`), {
      extra: { action: entry.action_type, ...sentryExtra },
    });
  }
}

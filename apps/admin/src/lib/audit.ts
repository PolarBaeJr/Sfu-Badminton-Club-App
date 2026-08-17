// Audit log helpers. NOT a 'use server' module — these are internal
// utilities imported by the admin server actions, not actions themselves.
import * as Sentry from '@sentry/nextjs';
import type { createAdminClient } from './supabase-server';

// Tournament-scoped audit trail (tournament_audit_log table).
//
// A failed write is reported to Sentry and never breaks the parent action —
// the same contract logAdminAudit states below, and it did NOT hold here until
// now. This function awaited the insert and dropped the `error` it resolved
// with: supabase-js resolves rather than rejects on a PostgREST failure, so
// every way a row could be refused — a revoked column grant, a constraint, a
// dropped socket — looked exactly like success, and the tournament audit trail
// could lose entries with nothing anywhere to say so. Silence was the one
// outcome neither of the two sensible policies wanted. Same shape as below so
// the two trails behave alike.
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
  const { error } = await adminClient.from('tournament_audit_log').insert({
    tournament_id: params.tournament_id ?? null,
    event_id: params.event_id ?? null,
    match_id: params.match_id ?? null,
    action: params.action,
    performed_by: params.performed_by,
    details: params.details ?? null,
  });
  if (error) {
    Sentry.captureException(new Error(`Tournament audit log write failed: ${error.message}`), {
      extra: {
        action: params.action,
        tournamentId: params.tournament_id ?? null,
        eventId: params.event_id ?? null,
        matchId: params.match_id ?? null,
      },
    });
  }
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
    // audit_logs.target_id is a `uuid` column. Null when the thing acted on has
    // no uuid at all — platform_settings is keyed by `key`, legal_documents by
    // `document`. Passing the text key here instead threw
    // "invalid input syntax for type uuid" on every insert; name it in `reason`
    // and leave this null.
    target_id: string | null;
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

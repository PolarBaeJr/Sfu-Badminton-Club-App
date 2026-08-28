// WHICH AUDIT FACTS MAY NOT BE LOST, AND WHAT HAPPENS WHEN ONE ALMOST IS.
//
// The audit helpers are best-effort: a failed insert is reported to Sentry and
// the parent mutation still succeeds. That is a deliberate choice and it stays,
// because the alternative is worse. Throwing after the mutation has landed
// reports failure for something that worked, and the operator's next move is to
// do it again — which for a fee, a ban or a rating repair means applying it
// twice. `confirmWalkover` has said so in a comment for a long time: throwing
// would skip the audit AND leave irreversible effects unattributed.
//
// What was wrong is not the policy, it is that the policy was applied uniformly.
// Money, permissions, moderation, rating repair, merges and deletions, disputes
// and tournament finalisation are the classes where a missing row is a
// governance problem rather than missing telemetry, and they got the same
// shrug as a session rename.
//
// So: two classes, one behaviour difference, no new subsystem.
//
//   REQUIRED   the FACT survives even when the payload cannot. On a failed
//              insert the helper retries with a degraded row — actor, action,
//              target and a reason naming the original error, with old_value
//              and new_value dropped. That is not a consolation prize: the
//              payload is the likeliest cause of the failure (a jsonb the
//              column refuses, an oversized value, a text key in a uuid
//              column — audit.ts documents having shipped exactly that bug),
//              so dropping it is usually the difference between a row and no
//              row. Both failures are reported.
//
//   ROUTINE    unchanged. One attempt, Sentry on failure, never throws.
//
// Neither class is transactional, and this file is the place that says so
// plainly rather than a doc that promises otherwise. Making the audit row
// commit with the mutation means moving each mutation into an RPC, and only
// two have made that trip: 00163 merge_players and 00177 apply_match_result
// write their audit facts in SQL and never reach this file at all. 00178 and
// 00179 are atomic but NOT self-auditing — their callers still log through
// here, so their audit row can be lost while the mutation stands.
// docs/ops/audit-policy.md
// carries the same statement for the people who do not read TypeScript.

/**
 * Action types whose audit fact may not be silently lost.
 *
 * Adding a high-risk action without adding it here is the drift this list
 * exists to prevent, so `audit-policy.test.ts` fails when an action_type in the
 * admin app matches one of the risk-class prefixes and is missing from this set.
 */
export const REQUIRED_AUDIT_ACTIONS: ReadonlySet<string> = new Set([
  // Money.
  'fee_waived',
  'fee_marked_paid',
  'fee_marked_unpaid',
  'manual_fee_added',
  'manual_fee_removed',
  'season_fees_updated',
  'expense_added',
  'expense_updated',
  'expense_removed',
  'expense_reimbursed',
  'other_income_added',
  'other_income_removed',
  'reinstatement_payment_recorded',
  'tournament_fee_marked_paid',
  'tournament_fee_marked_unpaid',
  'tournament_fee_tier_created',
  'tournament_fee_tier_updated',
  'tournament_fee_tier_deleted',

  // Permissions.
  'player_permissions_changed',
  'permission_baseline_created',
  'permission_baseline_updated',
  'permission_baseline_deleted',
  'platform_setting_updated',

  // Moderation and account standing.
  'player_banned',
  'player_reinstated',
  'player_removed',
  'player_approved',
  'player_flags_updated',

  // Rating repair.
  'reliability_adjusted',
  'match_voided',
  'match_converted_casual',

  // Disputes.
  'dispute_resolved',
  'walkover_confirmed',
  'walkover_rejected',

  // Destruction of club records. Not "financial", but a deleted row is the one
  // thing an audit trail cannot reconstruct from the data afterwards — which is
  // exactly the case the trail exists for. The drift test found all five of
  // these; they are here because the answer to "does this read riskier than it
  // is?" is settled by classifying it, not by arguing.
  'announcement_deleted',
  'session_deleted',
  'session_archived',
  'session_attendance_removed',
  'varsity_note_deleted',

  // Tournament finalisation and destruction.
  'tournament_deleted',
  'tournament_archived',
  'tournament_status_changed',
  'tournament_suspended',
  'tournament_event_force_completed',
  'season_ended',

  // Legal — the version string every member's acceptance is compared against.
  'legal_document_updated',
  'legal_document_reacceptance_required',
  'waiver_resignature_required',
  'event_waiver_template_updated',

  // Credentials.
  'passkey_removed',
  'passkey_counter_anomaly',
  'tournament_checkin_token_rotated',
  'session_checkin_token_rotated',
]);

/**
 * The risk-class prefixes the drift test scans for. An action_type matching one
 * of these and absent from the set above is either a genuine addition somebody
 * forgot to classify, or a name that reads riskier than it is — and the second
 * case is settled by adding it anyway.
 */
export const RISK_CLASS_PATTERNS: readonly RegExp[] = [
  /^fee_|_fee_|^manual_fee/,
  /^expense_|^other_income_/,
  /payment_recorded$/,
  /permission|baseline/,
  /^platform_setting_/,
  /^player_(banned|reinstated|removed|approved|flags_updated|permissions_changed)$/,
  /^dispute_|^walkover_/,
  /_deleted$|_archived$|_removed$/,
  /^legal_|waiver/,
  /^passkey_(removed|counter_anomaly)$/,
  /token_rotated$/,
  /^match_(voided|converted_casual)$/,
  /^reliability_adjusted$/,
  /^season_(ended|fees_updated)$/,
  /^tournament_(status_changed|suspended|event_force_completed)$/,
];

export function isRequiredAudit(actionType: string): boolean {
  return REQUIRED_AUDIT_ACTIONS.has(actionType);
}

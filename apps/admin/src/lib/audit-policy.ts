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

  // THE TOURNAMENT TRAIL, WHICH THIS SET SILENTLY DID NOT COVER.
  //
  // audit.ts's logAudit calls isRequiredAudit(params.action) against this very
  // set, and its comment claimed "every action on this trail that reaches a
  // completed event, a voided match or a deleted draw is in the required
  // class". Not one of them was. The tournament trail writes `action:`, the
  // admin trail writes `action_type:`, and the drift test below only ever
  // scanned the latter — so 32 action names went unclassified without the
  // guard that exists to prevent exactly that.
  //
  // This is not academic. The whole 00189/00190/00191 sequence exists because a
  // placement-bonus payment's audit row could go missing, which left no way to
  // tell a paid event from an unpaid one and forced a fail-closed marker keyed
  // on the event rather than the player. A degraded retry is what that row
  // needed and did not have.
  //
  // Same rule as above: irreversible rating movement, destruction of a record,
  // or the settlement of a contested result.
  'event_finalized',
  'event_deleted',
  'void_match',
  'match_voided',
  'unvoid_match',
  'match_unvoided',
  'convert_to_casual',
  'confirm_walkover',
  'reject_walkover',
  'enter_walkover',
  'walkover_entered',
  'double_no_show',
  'match_double_no_show',
  'result_edited',
  'result_undone',
  'participant_removed',
  'seeds_cleared',
  'draw_unlocked',
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
  // Tournament trail. `walkover` and `void` are matched as substrings on
  // purpose: the trail names the same fact four different ways
  // (enter_walkover / walkover_entered / confirm_walkover / reject_walkover,
  // and void_match / match_voided / unvoid_match / match_unvoided), and a
  // pattern anchored to one spelling is how the next one gets missed.
  /walkover/,
  /void/,
  /^event_(finalized|deleted)$/,
  /^convert_to_casual$/,
  /^double_no_show$|^match_double_no_show$/,
  /^result_(edited|undone)$/,
  /^participant_removed$/,
  /^seeds_cleared$/,
  /^draw_unlocked$/,
];

export function isRequiredAudit(actionType: string): boolean {
  return REQUIRED_AUDIT_ACTIONS.has(actionType);
}

/* -------------------------------------------------------------------------- */
/* The degraded-row sentinel                                                   */
/* -------------------------------------------------------------------------- */

/**
 * When a required audit write is refused, the fact is retried without its
 * payload (see ../audit.ts). The retried row is REAL — who did what, to what,
 * when — but it is missing the detail the first attempt carried, and a reader
 * who cannot tell the two apart will read a degraded row as a complete one.
 *
 * These are the marks that say "this row is degraded". They live here, next to
 * the classification that decides which rows get retried at all, because the
 * writer and the reader have to agree on them exactly and the last time two
 * halves of this system disagreed about a spelling — `action` versus
 * `action_type` — the degraded retry silently never ran for 32 action types.
 *
 * THE RULE: these strings appear nowhere else in the codebase. Both the writer
 * and the reader import them, and ./__tests__/audit-policy.test.ts fails if a
 * literal copy shows up in either file.
 */

/** jsonb key on `tournament_audit_log.details` for a dropped payload. */
export const AUDIT_PAYLOAD_DROPPED_KEY = 'audit_payload_dropped';

/** Human-readable marker appended to `audit_logs.reason` for a dropped payload. */
export const AUDIT_PAYLOAD_DROPPED_NOTE = 'audit payload dropped';

/**
 * The suffix the admin trail appends to the officer's own words. Built here so
 * that the reader's detector below and the writer cannot drift apart: there is
 * one construction and one recognition, and the round trip is tested.
 */
export function auditPayloadDroppedSuffix(message: string): string {
  return ` [${AUDIT_PAYLOAD_DROPPED_NOTE}: ${message.slice(0, 200)}]`;
}

/**
 * Whether an `audit_logs.reason` shows the payload was dropped.
 *
 * Substring, not prefix or exact match: the officer's typed reason comes first
 * and the marker is appended after it. Case-insensitive because the reason is
 * free text a human wrote and the marker sits inside it.
 */
export function isDegradedAuditReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return reason.toLowerCase().includes(`[${AUDIT_PAYLOAD_DROPPED_NOTE}:`);
}

/**
 * Whether a `tournament_audit_log.details` payload shows the same thing.
 *
 * Kept alongside the reason detector rather than in the tournament code so
 * that both trails' sentinels are read from one file. Accepts unknown because
 * the column is jsonb and a row written before this convention existed can
 * hold anything at all.
 */
export function isDegradedAuditDetails(details: unknown): boolean {
  return (
    typeof details === 'object' &&
    details !== null &&
    AUDIT_PAYLOAD_DROPPED_KEY in (details as Record<string, unknown>)
  );
}

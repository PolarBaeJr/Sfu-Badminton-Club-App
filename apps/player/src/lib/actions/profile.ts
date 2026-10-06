'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import {
  profileSchema,
  legalAcceptanceSchema,
  accountDeletionSchema,
  parseOrThrow,
  NOTIFICATION_CATEGORIES,
  emailPreferenceKey,
  getReminderLeadMinutes,
  ExpectedError,
  normalizeHandle,
  handleError,
  isHandleTakenError,
  HANDLE_TAKEN_MESSAGE,
  toCompetitionCategory,
  isCompetitionCategoryLockedError,
  COMPETITION_CATEGORY_LOCKED_MESSAGE,
  type CompetitionCategory,
  type LegalAcceptanceInput,
  type WaiverDocument,
  rosterRestoreColumns,
} from '@badminton/shared';
import { getSkillTierOptions, type SkillTierOption } from '../rating-tiers';
import { createServerSupabaseClient, createServiceRoleClient, getCurrentPlayer } from '../supabase-server';
import { logMemberAudit } from '../member-audit';
import {
  completeOnboardingCore,
  insertAcceptances,
  recordPasskeySetup,
  type OnboardingInput,
  type PasskeySetupOutcome,
} from '../onboarding-core';
import { requirePlayer, trackServerEvent, runAction, type ActionResult } from './_shared';

export async function updateProfile(data: {
  first_name: string;
  last_name?: string;
  handle?: string;
  phone?: string;
  bio?: string;
  hide_from_leaderboard?: boolean;
  competition_category?: CompetitionCategory | null;
}): Promise<ActionResult> {
  return runAction(() => updateProfileImpl(data));
}

/**
 * The signed-in member's own competition category (00111) — "Gender" on screen
 * since 00129.
 *
 * IT IS ALSO THE LOCK STATE, and that is why 00129 added no second call. A
 * locked field is exactly a non-NULL one: the member sets it once from NULL and
 * from then on only the console may change it, so `data !== null` is the whole
 * answer to "may I still edit this". Nothing else has to be fetched, and there
 * is no second predicate that could drift from the trigger's.
 *
 * A SERVER ACTION RATHER THAN A BROWSER READ, and that is the access control
 * rather than a style choice. `authenticated` has no SELECT grant on the
 * column, deliberately: the players_select policy admits any member to any
 * approved member's ROW, so the per-column grants are the only thing standing
 * between a private field and the whole club — and granting SELECT so that the
 * settings page could read it directly would publish everybody's category to
 * everybody. See 00111.
 *
 * requirePlayer() resolves the caller from their verified session and reads
 * their row with the service-role key, so there is no parameter for whose
 * category this is and no way to ask for somebody else's.
 */
export async function getMyCompetitionCategory(): Promise<ActionResult<CompetitionCategory | null>> {
  return runAction(async () => {
    const player = await requirePlayer();
    return toCompetitionCategory(
      (player as { competition_category?: unknown }).competition_category,
    );
  });
}

// Per-category push AND email preferences (players.notification_preferences
// JSONB). Only known category keys are persisted, coerced to booleans — an
// unknown key from the client is ignored rather than stored.
export async function updateNotificationPreferences(
  prefs: Record<string, boolean | number>,
): Promise<ActionResult> {
  return runAction(async () => {
    const player = await requirePlayer();
    const supabase = await createServerSupabaseClient();

    // `=== true`, not `!== false`: preferences are opt-in since 00058, so the
    // stored value has to be an explicit true. Coercing anything truthy-ish to
    // "on" would let a stray non-boolean subscribe someone.
    const clean: Record<string, boolean | number> = {};
    for (const c of NOTIFICATION_CATEGORIES) {
      if (c.key in prefs) clean[c.key] = prefs[c.key] === true;
      // Email toggles share this blob under an `email_` prefix.
      const emailKey = emailPreferenceKey(c.key);
      if (emailKey in prefs) clean[emailKey] = prefs[emailKey] === true;
    }
    // How much notice this player wants before a session. Clamped to the
    // sendable range, so a crafted request can't schedule a reminder a year out.
    if ('session_reminder_lead_minutes' in prefs) {
      clean.session_reminder_lead_minutes = getReminderLeadMinutes(prefs);
    }

    // MERGE onto what is stored rather than replacing it. Writing `clean`
    // directly silently destroyed every key the client did not send — so a
    // member flipping one push toggle would wipe an email unsubscribe and put
    // themselves back on the mailing list without either side noticing. The
    // whitelist above still governs what a caller may SET; merging governs
    // what survives.
    //
    // THE MERGE IS ONE STATEMENT IN THE DATABASE NOW (00180). Doing it here
    // meant a SELECT and an UPDATE with a window between them, and that window
    // had two ways to destroy preferences: a failed read arrived as null, the
    // merge started from {}, and the successful UPDATE that followed replaced
    // the whole blob with just the submitted keys; and two saves in quick
    // succession both read the same object, so the second overwrote the first.
    // Under the opt-in model of 00058 a key that vanishes is a key that is OFF,
    // so both of those unsubscribe somebody. `||` on jsonb inside a single
    // UPDATE has no window at all.
    const { error } = await supabase.rpc('merge_my_notification_preferences', {
      p_patch: clean,
    });

    if (error) {
      Sentry.captureException(error, { extra: { action: 'updateNotificationPreferences', playerId: player.id } });
      throw new Error(error.message);
    }
    revalidatePath('/settings');
  });
}

async function updateProfileImpl(data: {
  first_name: string;
  last_name?: string;
  handle?: string;
  phone?: string;
  bio?: string;
  hide_from_leaderboard?: boolean;
  competition_category?: CompetitionCategory | null;
}) {
  parseOrThrow(profileSchema, data);
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  // full_name is generated from these two (00023) — writing it would error.
  const update: Record<string, unknown> = {
    first_name: data.first_name,
    last_name: data.last_name ?? null,
  };
  // display_name is deliberately absent. The handle replaced it (00092): one
  // chosen name per member instead of a free-text nickname nobody could search
  // for. The column stays, and stays populated, because every handle was
  // derived from it — but nothing writes it any more.
  //
  // The handle is the one field on this form a member shares a namespace with
  // everyone else in, so it is normalized and checked here rather than left to
  // profileSchema: the rules are in a plain function (member-identity.ts) that
  // the settings form and the database CHECK are both written against, and
  // normalizing has to happen BEFORE the rules or every capital is a rejection.
  // NOT in profileSchema also because completeOnboarding parses that same schema
  // and collects no handle.
  if (data.handle !== undefined) {
    const handle = normalizeHandle(data.handle);
    const problem = handleError(handle);
    if (problem) throw new ExpectedError(problem);
    update.handle = handle;
  }
  if (data.phone !== undefined) update.phone = data.phone;
  if (data.bio !== undefined) update.bio = data.bio;
  if (data.hide_from_leaderboard !== undefined) update.hide_from_leaderboard = data.hide_from_leaderboard;
  // 00111 — the competition category, "Gender" on screen. THE MEMBER'S ONLY
  // WRITE PATH TO IT, and since 00129 a write they get exactly once: the
  // database refuses any later change, including back to NULL.
  //
  // STILL SENT UNCONDITIONALLY WHEN THE CALLER SUPPLIES IT, and the settings
  // form supplies it only while the field is unlocked. Filtering here on the
  // stored value would be a second copy of the lock rule, running on the wrong
  // side of the trust boundary and free to drift from the trigger's. The
  // trigger is the rule; this is a form field.
  if (data.competition_category !== undefined) {
    update.competition_category = data.competition_category;
  }

  const { error } = await supabase
    .from('players')
    .update(update)
    .eq('id', player.id);

  if (error) {
    // Somebody else got that handle first. The unique index is what decides
    // this — never a read followed by a write, because two members can claim the
    // same handle in the same second and both pass a prior check. Expected, so
    // it reaches the member as a sentence and Sentry as nothing.
    if (isHandleTakenError(error)) throw new ExpectedError(HANDLE_TAKEN_MESSAGE);
    // The write-once lock (00129) refusing a change to a declared Gender. Its
    // own sentence, and Sentry gets nothing: this is a rule the app enforces on
    // purpose and a member can reach it legitimately — a stale tab, a form
    // opened before an exec set the value, or getMyCompetitionCategory having
    // failed and collapsed the control to editable. None of those is a bug
    // worth waking anybody for, and all of them read as an unknown Postgres
    // string without this branch.
    if (isCompetitionCategoryLockedError(error)) {
      throw new ExpectedError(COMPETITION_CATEGORY_LOCKED_MESSAGE);
    }
    Sentry.captureException(error, { extra: { action: 'updateProfile', playerId: player.id } });
    throw new Error(error.message);
  }
  revalidatePath('/settings');
}

// The current legal document texts, for the onboarding waiver step and the
// waiver-gate overlay. Public to any authenticated user (RLS: read-only).
export async function getLegalDocuments(): Promise<
  ActionResult<{ document: WaiverDocument; version: string; content: string }[]>
> {
  return runAction(() => getLegalDocumentsImpl());
}

async function getLegalDocumentsImpl(): Promise<
  { document: WaiverDocument; version: string; content: string }[]
> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('legal_documents')
    .select('document, version, content');
  if (error) {
    Sentry.captureException(error, { extra: { action: 'getLegalDocuments' } });
    throw new Error(error.message);
  }
  // Callers sort with sortLegalDocuments for display.
  return data ?? [];
}

// Not requirePlayer(): pending_approval members must be able to accept, and
// existing members hit this from the blocking waiver gate after a version bump.
export async function acceptLegalDocuments(data: LegalAcceptanceInput): Promise<ActionResult> {
  return runAction(() => acceptLegalDocumentsImpl(data));
}

async function acceptLegalDocumentsImpl(data: LegalAcceptanceInput) {
  parseOrThrow(legalAcceptanceSchema, data);
  const player = await getCurrentPlayer();
  if (!player) throw new ExpectedError('Not authenticated');
  const supabase = await createServerSupabaseClient();

  await insertAcceptances(supabase, player.id, data.age_attestation, (await headers()).get('user-agent'));
  revalidatePath('/');
}

// Not requirePlayer(): pending_approval members must be able to delete their
// account too. Identity is derived only from the session — never from params.
// Nothing is destroyed here: the row is deactivated and stamped, the
// purge-deleted-accounts edge function anonymizes it after 30 days, and
// signing back in before then lets the player restore it (restoreMyAccount).
export async function deleteMyAccount(confirmation: string): Promise<ActionResult> {
  return runAction(() => deleteMyAccountImpl(confirmation));
}

async function deleteMyAccountImpl(confirmation: string) {
  parseOrThrow(accountDeletionSchema, { confirmation });
  const player = await getCurrentPlayer();
  if (!player) throw new ExpectedError('Not authenticated');

  // Service role: deletion_requested_at / active_flag aren't part of the
  // players self-update RLS surface.
  const service = createServiceRoleClient();
  // Hoisted so the audit row records the stamp that was actually written rather
  // than a second now() a few lines later.
  const deletionRequestedAt = new Date().toISOString();
  const { error } = await service
    .from('players')
    .update({ deletion_requested_at: deletionRequestedAt, active_flag: false })
    .eq('id', player.id);
  if (error) {
    Sentry.captureException(error, { extra: { action: 'deleteMyAccount', playerId: player.id } });
    throw new Error(error.message);
  }

  // AUDITED, because the console's own version of this write is. Clearing
  // active_flag and stamping deletion_requested_at is what cancelAccountDeletion
  // undoes, and that action files 'account_deletion_cancelled' with the previous
  // value; the request itself left nothing, so the audit log held the reversal of
  // a decision it had no record of. Three writers clear active_flag and the
  // console has to be able to tell them apart (see isSelfReactivatable) — this is
  // the one that says "they asked", and the row is what says so.
  //
  // trackServerEvent below is not that record. PostHog is product analytics: a
  // separate system, retention-limited, not joined to the member's row and not
  // readable from /audit, which is the screen an exec opens to answer "why is
  // this account deactivated". The two are both worth having.
  await logMemberAudit({
    playerId: player.id,
    actionType: 'self_deletion_requested',
    oldValue: { deletion_requested_at: null, active_flag: player.active_flag ?? null },
    newValue: { deletion_requested_at: deletionRequestedAt, active_flag: false },
    reason: 'Member requested deletion of their own account',
  });

  trackServerEvent(player.id, 'account_deletion_requested', {});
}

// Self-service revert path during the 30-day retention window.
export async function restoreMyAccount(): Promise<ActionResult> {
  return runAction(() => restoreMyAccountImpl());
}

async function restoreMyAccountImpl() {
  const player = await getCurrentPlayer();
  if (!player) throw new ExpectedError('Not authenticated');
  if (!player.deletion_requested_at) throw new ExpectedError('No deletion is scheduled for this account');

  const service = createServiceRoleClient();
  // The member's twin of cancelAccountDeletion, and it takes the same full
  // restore column set for the same reason: without the last_active_at bump the
  // nightly job re-deactivates them and mails the inactivity notice, so the
  // member cancels a deletion and is told the next morning that their
  // membership has lapsed.
  const restore = rosterRestoreColumns(new Date().toISOString());
  const { error } = await service
    .from('players')
    .update({ deletion_requested_at: null, ...restore })
    .eq('id', player.id);
  if (error) {
    Sentry.captureException(error, { extra: { action: 'restoreMyAccount', playerId: player.id } });
    throw new Error(error.message);
  }

  // The member's twin of cancelAccountDeletion, which files
  // 'account_deletion_cancelled'. A DIFFERENT action_type on purpose: the two
  // writes are identical and the actors are not, and an /audit reader who cannot
  // tell "an admin rescued this account" from "the member changed their mind" has
  // been told less than the log knows. Same reasoning as 'self_reactivated'
  // sitting beside 'auto_marked_inactive'.
  await logMemberAudit({
    playerId: player.id,
    actionType: 'self_deletion_cancelled',
    oldValue: {
      deletion_requested_at: player.deletion_requested_at,
      active_flag: false,
      last_active_at: player.last_active_at,
      inactive_since: player.inactive_since,
    },
    newValue: { deletion_requested_at: null, ...restore },
    reason: 'Member cancelled the deletion of their own account',
  });

  trackServerEvent(player.id, 'account_deletion_cancelled', {});
  revalidatePath('/');
}

export type { PasskeySetupOutcome };

export async function completeOnboarding(data: OnboardingInput): Promise<ActionResult> {
  return runAction(() => completeOnboardingImpl(data));
}

// The body is shared with Discord /signup (onboarding-core.ts). The web's part
// is where the user, the player and the user agent come from: the session
// cookies and this request.
async function completeOnboardingImpl(data: OnboardingInput) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new ExpectedError('Not authenticated');

  await completeOnboardingCore(supabase, user, data, {
    userAgent: (await headers()).get('user-agent'),
    loadPlayer: getCurrentPlayer,
  });

  revalidatePath('/');
}

/**
 * The tiers onboarding offers, with the rating each one currently seeds.
 *
 * A server action because the onboarding screen is a client component and the
 * numbers live in platform_settings — the same reason passkeysConfigured()
 * exists. No auth gate beyond the session the reader's client already carries:
 * these are the club's published rating rules, already readable by any
 * authenticated member through settings_select, and the caller is by definition
 * a signed-in member halfway through making an account.
 */
export async function getSkillTiers(): Promise<SkillTierOption[]> {
  return getSkillTierOptions();
}

/**
 * Whether the club approves new signups by itself (00220,
 * signup_settings.auto_approve_enabled), so onboarding can say what happens
 * after "Enter the club" rather than promising a wait that may not come.
 *
 * Same reader as getSkillTiers: platform_settings is readable by any
 * authenticated member. Read the way platform_setting_bool() reads it, and a
 * failed or absent read is FALSE, the trigger's own default, so the screen
 * never promises an instant approval the database will not give.
 */
export async function getSignupApprovalMode(): Promise<boolean> {
  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'signup_settings')
      .maybeSingle();
    if (error) return false;
    const raw = (data?.value as Record<string, unknown> | null)?.auto_approve_enabled;
    return raw === true || raw === 'true';
  } catch {
    return false;
  }
}

/**
 * Record that the member enrolled a passkey, after the fact.
 *
 * Onboarding cannot enrol before completeOnboarding runs: the register route
 * needs a `players` row and nothing creates one until then (there is no trigger
 * on auth.users). So the enrolment happens immediately AFTER, and this carries
 * the outcome back to the column that completeOnboarding could only guess at.
 *
 * Same swallow-and-report contract as recordPasskeySetup: this is an analytics
 * column, and a member who has just enrolled a working passkey must never see
 * an error because a string would not save.
 */
export async function markPasskeyEnrolled(): Promise<void> {
  const player = await getCurrentPlayer();
  if (!player) return;
  await recordPasskeySetup(player.id as string, 'enrolled');
}

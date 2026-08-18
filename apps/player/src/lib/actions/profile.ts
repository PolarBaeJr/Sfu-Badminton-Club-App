'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import {
  profileSchema,
  legalAcceptanceSchema,
  accountDeletionSchema,
  parseOrThrow,
  getMissingLegalDocuments,
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
  isSkillTier,
  type SkillTier,
  type CompetitionCategory,
  type LegalAcceptanceInput,
  type WaiverDocument,
  rosterRestoreColumns,
} from '@badminton/shared';
import { getSkillTierOptions, type SkillTierOption } from '../rating-tiers';
import { normalizeEmail } from '../roster-claim';
import { ensurePlayerRowForUser } from '../first-signin';
import { createServerSupabaseClient, createServiceRoleClient, getCurrentPlayer } from '../supabase-server';
import { logMemberAudit } from '../member-audit';
import { requirePlayer, trackServerEvent, runAction, type ActionResult } from './_shared';

export async function updateProfile(data: {
  first_name: string;
  last_name?: string;
  handle?: string;
  phone?: string;
  bio?: string;
  hide_from_leaderboard?: boolean;
  show_activity_status?: boolean;
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

    // MERGE onto what is stored rather than replacing it. This used to write
    // `clean` directly, which silently destroyed every key the client did not
    // send — so a member flipping one push toggle would wipe an email
    // unsubscribe and put themselves back on the mailing list without either
    // side noticing. The whitelist above still governs what a caller may SET;
    // merging governs what survives.
    const { data: existing } = await supabase
      .from('players')
      .select('notification_preferences')
      .eq('id', player.id)
      .maybeSingle();

    const merged = {
      ...((existing?.notification_preferences as Record<string, unknown> | null) ?? {}),
      ...clean,
    };

    const { error } = await supabase
      .from('players')
      .update({ notification_preferences: merged })
      .eq('id', player.id);

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
  show_activity_status?: boolean;
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
  if (data.show_activity_status !== undefined) update.show_activity_status = data.show_activity_status;
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

// Insert acceptance rows for the documents the player is still missing —
// never touching prior rows, which are append-only evidence (00014 dropped
// the unique key so the annual waiver renewal adds a NEW row). Only inserting
// the missing/expired set keeps re-acceptance idempotent in effect.
async function insertAcceptances(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  playerId: string,
  ageAttestation: boolean
) {
  const { data: docs, error: docsError } = await supabase
    .from('legal_documents')
    .select('document, version, reacceptance_required_since');
  if (docsError) {
    Sentry.captureException(docsError, { extra: { action: 'insertAcceptances', playerId } });
    throw new Error(docsError.message);
  }
  if (!docs || docs.length === 0) return;

  const { data: existing, error: existingError } = await supabase
    .from('waiver_acceptances')
    .select('document, version, accepted_at')
    .eq('player_id', playerId);
  if (existingError) {
    Sentry.captureException(existingError, { extra: { action: 'insertAcceptances', playerId } });
    throw new Error(existingError.message);
  }

  // Same inputs as the layout's waiver gate — including the per-player
  // waiver_reset_at — or the two disagree and the accept loop deadlocks
  // (gate shows but this inserts nothing).
  const { data: playerRow } = await supabase
    .from('players')
    .select('waiver_reset_at')
    .eq('id', playerId)
    .maybeSingle();

  const missing = getMissingLegalDocuments(docs, existing ?? [], new Date(), playerRow?.waiver_reset_at ?? null);
  if (missing.length === 0) return;

  const versionByDoc = new Map(docs.map((doc) => [doc.document, doc.version]));
  const userAgent = (await headers()).get('user-agent');
  const { error } = await supabase.from('waiver_acceptances').insert(
    missing.map((document) => ({
      player_id: playerId,
      document,
      version: versionByDoc.get(document)!,
      age_attestation: ageAttestation,
      user_agent: userAgent,
    }))
  );
  if (error) {
    Sentry.captureException(error, { extra: { action: 'insertAcceptances', playerId } });
    throw new Error(error.message);
  }
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

  await insertAcceptances(supabase, player.id, data.age_attestation);
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

// What onboarding reports about the passkey question (00121). Kept as a plain
// tuple rather than added to profileSchema: this is a record of what the client
// observed about its own browser, not a profile field the member typed, and it
// must never be able to fail the whole onboarding submit. An unrecognised value
// is dropped silently — losing one analytics answer is nothing next to
// stranding a member at the door for sending a string we did not expect.
const PASSKEY_SETUP_VALUES = ['enrolled', 'declined', 'unsupported', 'unavailable'] as const;
export type PasskeySetupOutcome = (typeof PASSKEY_SETUP_VALUES)[number];

type OnboardingInput = {
  first_name: string;
  last_name?: string;
  display_name?: string;
  phone?: string;
  waiver_accepted: boolean;
  code_of_conduct_accepted: boolean;
  terms_accepted: boolean;
  age_attestation: boolean;
  passkey_setup?: PasskeySetupOutcome;
  // The skill tier the member picked (00127). Carried the same way
  // passkey_setup is — outside profileSchema, and applied AFTER the player and
  // ratings rows exist, because before completeOnboarding there is nothing to
  // seed. An unrecognised or absent value seeds nothing and the member simply
  // starts at default_elo, which is what happened before tiering shipped.
  skill_tier?: SkillTier;
};

export async function completeOnboarding(data: OnboardingInput): Promise<ActionResult> {
  return runAction(() => completeOnboardingImpl(data));
}

async function completeOnboardingImpl(data: OnboardingInput) {
  parseOrThrow(profileSchema, data);
  parseOrThrow(legalAcceptanceSchema, data);
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new ExpectedError('Not authenticated');

  // ONE CLAIM IMPLEMENTATION, AND IT IS NOT HERE ANY MORE (00132). This used to
  // hold its own copy of the claim — find an unclaimed roster row by email,
  // adopt it, strip its privileges — because onboarding was the first moment a
  // `players` row existed at all. The row is now made at first sign-in, so the
  // claim has to happen there or first sign-in would insert a SECOND row for
  // somebody an exec had already pre-added, which is the exact duplicate the
  // claim exists to prevent.
  //
  // Keeping a second copy here would mean two claim implementations that could
  // disagree about privileges, so this calls the same function the sign-in
  // routes do. It is idempotent and by this point has almost always already run;
  // the call stays because "almost always" is not a guarantee — a session
  // predating the deploy, or a sign-in whose ensure failed transiently, must
  // still be able to finish onboarding.
  await ensurePlayerRowForUser(user.id);

  const existingPlayer = await getCurrentPlayer();
  let playerId = existingPlayer?.id ?? null;

  // Still nothing, with a live session and a confirmed address, means
  // ensure_player_for_user DECLINED — and the only thing it declines for is an
  // ambiguous roster match (two unclaimed rows for one address). It cannot say
  // so at sign-in because sign-in has no screen to say it on. This is that
  // screen, and this is the sentence it used to throw from its own lookup.
  //
  // players_email_lower_key (00066) makes a second match impossible going
  // forward; this stays because the app deploys independently of the migration
  // and because picking one of the two would attach the member to an arbitrary
  // row and its arbitrary history.
  if (!existingPlayer && user.email) {
    const { data: matches } = await createServiceRoleClient()
      .from('players')
      .select('id')
      .is('user_id', null)
      .eq('email', normalizeEmail(user.email))
      .limit(2);
    if (matches && matches.length > 1) {
      throw new ExpectedError(
        'There is more than one club record for your email address. Please contact an exec to have them merged before finishing setup.',
      );
    }
  }

  if (existingPlayer) {
    const update: Record<string, unknown> = { onboarding_completed: true };

    // THE ADMIN-ENTERED NAME STAYS AUTHORITATIVE, and this branch is newly the
    // one that could have broken that. Before 00132 a claimed roster row only
    // reached here after the claim, which never touched first_name/last_name —
    // roster-claim states the rule: "the admin-entered name/email/status stay
    // authoritative (same rule the merge tool follows); onboarding only supplies
    // what the admin could not know". The row now exists BEFORE onboarding runs,
    // so every claimed member takes this branch, and writing the name
    // unconditionally would have silently reversed that rule for all of them.
    //
    // A STUB, on the other hand, has first_name = '' and this is the only thing
    // that ever fills it. So the test is on the stored value, not on which path
    // got here: a blank name is filled, an admin's is left alone.
    if (!String(existingPlayer.first_name ?? '').trim()) {
      update.first_name = data.first_name;
      update.last_name = data.last_name ?? null;
    }
    if (data.display_name) update.display_name = data.display_name;
    if (data.phone) update.phone = data.phone;

    const { error } = await supabase
      .from('players')
      .update(update)
      .eq('id', existingPlayer.id);

    if (error) {
      Sentry.captureException(error, { extra: { action: 'completeOnboarding', playerId: existingPlayer.id } });
      throw new Error(error.message);
    }
  } else if (!playerId) {
    // Only insert when nothing was claimed above — otherwise onboarding would
    // create the very duplicate the claim step exists to prevent.
    // create_player_with_rating (migration 00003_functions.sql) inserts the
    // player and ratings rows in one transaction. Its internal guard mirrors
    // the players_self_insert RLS policy (00005_rls.sql): user_id = auth.uid(),
    // status = 'pending_approval', role = 'player'.
    //
    // NOT AUDITED, unlike its console twin createPlayer, and that asymmetry was
    // examined rather than inherited. Three things separate them. An audit row
    // exists to preserve what a write DESTROYED or to name who decided
    // something; this destroys nothing — there is no prior state, and the row's
    // own created_at is already the durable record that it appeared and when.
    // Nobody decided anything either: the function's guard pins user_id to the
    // session, the status to pending_approval and the role to 'player', so the
    // only content of the act is "somebody signed up", and the decision that
    // follows — approval — IS audited, with the whole signup row as old_value.
    // And since 00132 the row is normally made by ensure_player_for_user at
    // first sign-in, so a row per call here would be a partial census of
    // signups filed under a fallback path. One audit_logs row per member for a
    // fact players.created_at already holds is noise in the log that the
    // entries above have to be found in.
    const { error } = await supabase.rpc('create_player_with_rating', {
      p_user_id: user.id,
      p_email: user.email!,
      p_first_name: data.first_name,
      p_last_name: data.last_name || null,
      p_display_name: data.display_name || null,
      p_phone: data.phone || null,
    });

    if (error) {
      Sentry.captureException(error, { extra: { action: 'completeOnboarding', userId: user.id } });
      throw new Error(error.message);
    }

    // Re-fetch for the freshly created row's id.
    playerId = (await getCurrentPlayer())?.id ?? null;
  }

  if (playerId) {
    await insertAcceptances(supabase, playerId, data.age_attestation);
    await recordPasskeySetup(playerId, data.passkey_setup);
    // AFTER the row exists, and after nothing else depends on it. Ordering is
    // the whole reason this is a separate call rather than a column on the
    // insert above: on the claim path and the existing-player path there is no
    // insert to hang it on, and on all three paths the seed has to inspect the
    // ratings row it is about to overwrite.
    await applySkillTier(playerId, data.skill_tier);
  }

  revalidatePath('/');
}

/**
 * Store the member's answer to the passkey question (00121).
 *
 * Written with the SERVICE-ROLE client rather than folded into the `players`
 * update above, for two reasons. The column carries no column-level GRANT on
 * purpose — see the migration header — so the member's own client cannot write
 * it; and keeping it out of that update means a problem with this column can
 * never fail the statement that sets onboarding_completed. The member gets in
 * either way.
 *
 * Failures are swallowed for the same reason: the last thing onboarding should
 * do is refuse to finish because an analytics column would not take. Sentry
 * keeps the record.
 */
async function recordPasskeySetup(playerId: string, outcome: string | undefined) {
  if (!outcome || !PASSKEY_SETUP_VALUES.includes(outcome as PasskeySetupOutcome)) return;
  try {
    const { error } = await createServiceRoleClient()
      .from('players')
      .update({ passkey_setup: outcome })
      .eq('id', playerId);
    if (error) throw new Error(error.message);
  } catch (error) {
    Sentry.captureException(error, {
      extra: { action: 'recordPasskeySetup', playerId, outcome },
    });
  }
}

/**
 * Seed the starting rating from the skill tier the member claimed (00127).
 *
 * ALL THE JUDGEMENT IS IN SQL, ON PURPOSE. apply_skill_tier_seed resolves the
 * tier name to a rating out of platform_settings, clamps it to the ladder, and
 * refuses to touch a rating that has ever moved (matches played, or a season
 * snapshot). Doing any of that here would mean two implementations of the same
 * rule that can drift, and the dangerous half — "is this rating safe to
 * overwrite" — would be the half running on the client's side of the trust
 * boundary.
 *
 * A TIER NAME IS SENT, NEVER A RATING. The function takes 'beginner' |
 * 'intermediate' | 'advanced'. If this passed an integer into a SECURITY
 * DEFINER function, a hostile client would be able to type itself to the top of
 * the ladder — the same escalation shape 00056 closed on player inserts.
 *
 * Service-role, because that is the only grant the function carries: a
 * SECURITY DEFINER routine that rewrites an arbitrary player's rating is not
 * something a member's own session should be able to reach.
 *
 * Same swallow-and-report contract as recordPasskeySetup. This is the last step
 * of onboarding; a member who has just accepted the waiver and enrolled a
 * passkey must not be bounced back to step three because a rating seed failed.
 * They land at default_elo — exactly where every member landed before tiering
 * existed — and Sentry keeps the record.
 *
 * AUDITED WHEN IT ACTUALLY SEEDS. This is a rating rewrite, and a rating is the
 * one number the whole ladder is for: singles_elo and doubles_elo are on
 * PLAYER_FIELD_PRIVILEGED in the admin app precisely so no exec can move one by
 * hand, and the admin who may writes an audit row with the previous rating and a
 * typed reason. The member's route to the same two columns wrote nothing, so a
 * rating that arrived here was indistinguishable from a rating that had always
 * been there.
 *
 * ONLY WHEN THE FUNCTION SAYS IT WROTE. apply_skill_tier_seed returns TRUE only
 * when a rating was actually written — its own comment says the boolean exists
 * "so the caller can tell 'seeded' from 'declined to seed' rather than guessing"
 * — and it declines whenever the rating has ever moved or was set deliberately by
 * an exec. Auditing unconditionally would file rows claiming rating changes that
 * the guard refused, which is worse than filing none.
 *
 * THE TIER IS LOGGED, NOT THE RESULTING RATING. The number is resolved in SQL out
 * of platform_settings, clamped to the ladder, and the migration is explicit that
 * duplicating that arithmetic in TypeScript is the two-implementations drift it
 * was written to avoid. The tier is what the member claimed and what the audit
 * reader needs; the rating it produced is on the ratings row.
 */
async function applySkillTier(playerId: string, tier: string | undefined) {
  if (!isSkillTier(tier)) return;
  try {
    const { data: seeded, error } = await createServiceRoleClient().rpc('apply_skill_tier_seed', {
      p_player_id: playerId,
      p_tier: tier,
    });
    if (error) throw new Error(error.message);
    if (seeded === true) {
      await logMemberAudit({
        playerId,
        // `rating`, not `tier`, is the word that files this under Members in the
        // console's audit taxonomy — `tier` belongs to the tournament fee tiers
        // and would land a rating change on the Money tab.
        actionType: 'self_rating_seeded',
        // No old_value: the function's own precondition is that the rating was
        // still untouched at default_elo, so the previous figure is the club's
        // default rather than a fact about this member.
        newValue: { skill_tier: tier },
        reason: 'Starting rating seeded from the skill level claimed at onboarding',
      });
    }
  } catch (error) {
    Sentry.captureException(error, {
      extra: { action: 'applySkillTier', playerId, tier },
    });
  }
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

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
  type LegalAcceptanceInput,
  type WaiverDocument,
} from '@badminton/shared';
import { buildRosterClaim, normalizeEmail } from '../roster-claim';
import { createServerSupabaseClient, createServiceRoleClient, getCurrentPlayer } from '../supabase-server';
import { requirePlayer, trackServerEvent, runAction, type ActionResult } from './_shared';

export async function updateProfile(data: {
  first_name: string;
  last_name?: string;
  display_name?: string;
  phone?: string;
  bio?: string;
  hide_from_leaderboard?: boolean;
  show_activity_status?: boolean;
}): Promise<ActionResult> {
  return runAction(() => updateProfileImpl(data));
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
  display_name?: string;
  phone?: string;
  bio?: string;
  hide_from_leaderboard?: boolean;
  show_activity_status?: boolean;
}) {
  parseOrThrow(profileSchema, data);
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  // full_name is generated from these two (00023) — writing it would error.
  const update: Record<string, unknown> = {
    first_name: data.first_name,
    last_name: data.last_name ?? null,
  };
  if (data.display_name !== undefined) {
    // Empty string -> null so the column isn't stuck with ''.
    update.display_name = data.display_name === '' ? null : data.display_name;
  }
  if (data.phone !== undefined) update.phone = data.phone;
  if (data.bio !== undefined) update.bio = data.bio;
  if (data.hide_from_leaderboard !== undefined) update.hide_from_leaderboard = data.hide_from_leaderboard;
  if (data.show_activity_status !== undefined) update.show_activity_status = data.show_activity_status;

  const { error } = await supabase
    .from('players')
    .update(update)
    .eq('id', player.id);

  if (error) {
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
  if (!player) throw new Error('Not authenticated');
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
  if (!player) throw new Error('Not authenticated');

  // Service role: deletion_requested_at / active_flag aren't part of the
  // players self-update RLS surface.
  const service = createServiceRoleClient();
  const { error } = await service
    .from('players')
    .update({ deletion_requested_at: new Date().toISOString(), active_flag: false })
    .eq('id', player.id);
  if (error) {
    Sentry.captureException(error, { extra: { action: 'deleteMyAccount', playerId: player.id } });
    throw new Error(error.message);
  }

  trackServerEvent(player.id, 'account_deletion_requested', {});
}

// Self-service revert path during the 30-day retention window.
export async function restoreMyAccount(): Promise<ActionResult> {
  return runAction(() => restoreMyAccountImpl());
}

async function restoreMyAccountImpl() {
  const player = await getCurrentPlayer();
  if (!player) throw new Error('Not authenticated');
  if (!player.deletion_requested_at) throw new Error('No deletion is scheduled for this account');

  const service = createServiceRoleClient();
  const { error } = await service
    .from('players')
    .update({ deletion_requested_at: null, active_flag: true })
    .eq('id', player.id);
  if (error) {
    Sentry.captureException(error, { extra: { action: 'restoreMyAccount', playerId: player.id } });
    throw new Error(error.message);
  }

  trackServerEvent(player.id, 'account_deletion_cancelled', {});
  revalidatePath('/');
}

export async function completeOnboarding(data: {
  first_name: string;
  last_name?: string;
  display_name?: string;
  phone?: string;
  waiver_accepted: boolean;
  code_of_conduct_accepted: boolean;
  terms_accepted: boolean;
  age_attestation: boolean;
}): Promise<ActionResult> {
  return runAction(() => completeOnboardingImpl(data));
}

async function completeOnboardingImpl(data: {
  first_name: string;
  last_name?: string;
  display_name?: string;
  phone?: string;
  waiver_accepted: boolean;
  code_of_conduct_accepted: boolean;
  terms_accepted: boolean;
  age_attestation: boolean;
}) {
  parseOrThrow(profileSchema, data);
  parseOrThrow(legalAcceptanceSchema, data);
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const existingPlayer = await getCurrentPlayer();
  let playerId = existingPlayer?.id ?? null;

  // Claim an unclaimed roster row before creating a new one. Admins routinely
  // pre-add members (user_id IS NULL) who later sign up themselves; without
  // this, onboarding always inserts a SECOND row and someone has to merge the
  // two by hand. Matching on the email is safe here specifically because
  // sign-in is OTP/OAuth — the address is proven, not self-asserted — and we
  // only ever attach to a row nobody has claimed yet.
  //
  // What the claim may carry over is decided in lib/roster-claim: it links the
  // login and never confers console privilege.
  //
  // Needs the service-role client: under RLS the user cannot see or update a
  // players row that isn't linked to them yet.
  if (!existingPlayer && user.email) {
    const serviceClient = createServiceRoleClient();
    // .eq, not .ilike — see normalizeEmail. limit(2) rather than maybeSingle():
    // players_email_lower_key (00066) makes a second match impossible going
    // forward, but maybeSingle() THROWS on two rows, and this code deploys
    // independently of the migration. A throw here blocks that person's
    // onboarding with no way out, so ask for two and refuse deliberately.
    const { data: matches, error: lookupError } = await serviceClient
      .from('players')
      .select('id, role, is_exec, is_trainer')
      .is('user_id', null)
      .eq('email', normalizeEmail(user.email))
      .limit(2);
    if (lookupError) {
      Sentry.captureException(lookupError, { extra: { action: 'claimRosterRow', userId: user.id } });
      throw new Error(lookupError.message);
    }
    if (matches && matches.length > 1) {
      // Picking one would attach the member to an arbitrary row and its
      // arbitrary history. Fail closed and name the fix.
      throw new ExpectedError(
        'There is more than one club record for your email address. Please contact an exec to have them merged before finishing setup.',
      );
    }

    const unclaimed = matches?.[0];
    if (unclaimed) {
      const { update, stripped } = buildRosterClaim(unclaimed, user.id, {
        display_name: data.display_name,
        phone: data.phone,
      });

      const { error } = await serviceClient.from('players').update(update).eq('id', unclaimed.id);
      if (error) {
        Sentry.captureException(error, { extra: { action: 'claimRosterRow', userId: user.id } });
        throw new Error(error.message);
      }
      playerId = unclaimed.id;

      // An admin pre-added this person WITH privileges and they came off. Say
      // so on the record, or the admin has no way to know their intent was
      // downgraded and no prompt to re-grant it deliberately.
      if (stripped) {
        const { error: auditError } = await serviceClient.from('audit_logs').insert({
          actor_id: unclaimed.id,
          action_type: 'roster_row_claimed_privileges_stripped',
          target_type: 'player',
          target_id: unclaimed.id,
          old_value: stripped,
          new_value: { role: 'player', is_exec: false, is_trainer: false },
          reason:
            'Roster row claimed at onboarding. A claim links a login and never grants console access — re-grant deliberately from Players → Edit if it was intended.',
        });
        // The claim itself succeeded; a failed audit write must not undo it or
        // block the member. Sentry is the backstop.
        if (auditError) {
          Sentry.captureException(auditError, {
            extra: { action: 'claimRosterRowAudit', playerId: unclaimed.id, stripped },
          });
        }
      }
    }
  }

  if (existingPlayer) {
    const update: Record<string, unknown> = {
      first_name: data.first_name,
      last_name: data.last_name ?? null,
      onboarding_completed: true,
    };
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
  }

  revalidatePath('/');
}

// The body of finishing onboarding, shared by the web onboarding page and
// Discord /signup. NOT a 'use server' module: these functions take the user,
// the member's client and the player loader as parameters, so none of them may
// be reachable as a Server Action.
//
// The two doors differ only in where those come from. The web reads the user
// and the player off the session cookies and the user agent off the request.
// Discord has just verified an emailed code, so it holds a member client built
// from that access token, reads the player by the verified user id, and
// records 'Discord /signup' as the user agent. Everything else, including the
// order the writes happen in, is written once, here.
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  onboardingProfileSchema,
  legalAcceptanceSchema,
  parseOrThrow,
  getMissingLegalDocuments,
  ExpectedError,
  categoryFromSignupAnswer,
  isCompetitionCategoryLockedError,
  isSkillTier,
  type SignupEventsAnswer,
  type SkillTier,
} from '@badminton/shared';
import { normalizeEmail } from './roster-claim';
import { ensurePlayerRowForUser } from './first-signin';
import { createServiceRoleClient } from './supabase-server';
import { logMemberAudit } from './member-audit';

// What onboarding reports about the passkey question (00121). Kept as a plain
// tuple rather than added to profileSchema: this is a record of what the client
// observed about its own browser, not a profile field the member typed, and it
// must never be able to fail the whole onboarding submit. An unrecognised value
// is dropped silently: losing one analytics answer is nothing next to
// stranding a member at the door for sending a string we did not expect.
const PASSKEY_SETUP_VALUES = ['enrolled', 'declined', 'unsupported', 'unavailable'] as const;
export type PasskeySetupOutcome = (typeof PASSKEY_SETUP_VALUES)[number];

export type OnboardingInput = {
  first_name: string;
  last_name: string;
  display_name?: string;
  phone?: string;
  // "Which events do you play in tournaments?" Required; 'open' is stored as
  // NULL in competition_category.
  event_category: SignupEventsAnswer;
  waiver_accepted: boolean;
  code_of_conduct_accepted: boolean;
  terms_accepted: boolean;
  age_attestation: boolean;
  passkey_setup?: PasskeySetupOutcome;
  // The skill tier the member picked (00127). Carried the same way
  // passkey_setup is: outside profileSchema, and applied AFTER the player and
  // ratings rows exist, because before completeOnboarding there is nothing to
  // seed. An unrecognised or absent value seeds nothing and the member simply
  // starts at default_elo, which is what happened before tiering shipped.
  skill_tier?: SkillTier;
};

type PlayerRow = Record<string, unknown> & { id: string; first_name?: string | null };

export async function completeOnboardingCore(
  supabase: SupabaseClient,
  user: { id: string; email?: string | null },
  data: OnboardingInput,
  options: { userAgent: string | null; loadPlayer: () => Promise<PlayerRow | null> },
): Promise<{ playerId: string | null }> {
  const profile = parseOrThrow(onboardingProfileSchema, data);
  parseOrThrow(legalAcceptanceSchema, data);
  const category = categoryFromSignupAnswer(profile.event_category);

  // ONE CLAIM IMPLEMENTATION, AND IT IS NOT HERE ANY MORE (00132). This used to
  // hold its own copy of the claim (find an unclaimed roster row by email,
  // adopt it, strip its privileges) because onboarding was the first moment a
  // `players` row existed at all. The row is now made at first sign-in, so the
  // claim has to happen there or first sign-in would insert a SECOND row for
  // somebody an exec had already pre-added, which is the exact duplicate the
  // claim exists to prevent.
  //
  // Keeping a second copy here would mean two claim implementations that could
  // disagree about privileges, so this calls the same function the sign-in
  // routes do. It is idempotent and by this point has almost always already run;
  // the call stays because "almost always" is not a guarantee: a session
  // predating the deploy, or a sign-in whose ensure failed transiently, must
  // still be able to finish onboarding.
  await ensurePlayerRowForUser(user.id);

  const existingPlayer = await options.loadPlayer();
  let playerId = existingPlayer?.id ?? null;

  // Still nothing, with a live session and a confirmed address, means
  // ensure_player_for_user DECLINED, and the only thing it declines for is an
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
    // THE WAIVER GOES ON RECORD BEFORE THE FLAG, not after. self_serve_auto_approve
    // is a trigger on onboarding_completed, so the statement below is what approves
    // the member: writing it first meant the club approved somebody whose acceptance
    // rows did not exist yet, and anything that threw in between left an approved
    // member with no waiver on record permanently. The acceptance is the durable
    // fact and has to be written first.
    //
    // The call further down stays exactly where it is. It is driven by
    // getMissingLegalDocuments, so once this one has run it finds nothing missing
    // and inserts nothing; the account-creation path still needs it because the
    // player id does not exist until after the insert.
    await insertAcceptances(supabase, existingPlayer.id, data.age_attestation, options.userAgent);

    // Before the flag too, so an approved member never exists without the
    // answer they gave.
    await writeSignupCategory(supabase, existingPlayer.id, category);

    const update: Record<string, unknown> = { onboarding_completed: true };

    // THE ADMIN-ENTERED NAME STAYS AUTHORITATIVE, and this branch is newly the
    // one that could have broken that. Before 00132 a claimed roster row only
    // reached here after the claim, which never touched first_name/last_name;
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
      update.first_name = profile.first_name;
      update.last_name = profile.last_name;
    }
    if (profile.display_name) update.display_name = profile.display_name;
    if (profile.phone) update.phone = profile.phone;

    const { error } = await supabase
      .from('players')
      .update(update)
      .eq('id', existingPlayer.id);

    if (error) {
      Sentry.captureException(error, { extra: { action: 'completeOnboarding', playerId: existingPlayer.id } });
      throw new Error(error.message);
    }
  } else if (!playerId) {
    // Only insert when nothing was claimed above; otherwise onboarding would
    // create the very duplicate the claim step exists to prevent.
    // create_player_with_rating (migration 00003_functions.sql) inserts the
    // player and ratings rows in one transaction. Its internal guard mirrors
    // the players_self_insert RLS policy (00005_rls.sql): user_id = auth.uid(),
    // status = 'pending_approval', role = 'player'.
    //
    // NOT AUDITED, unlike its console twin createPlayer, and that asymmetry was
    // examined rather than inherited. Three things separate them. An audit row
    // exists to preserve what a write DESTROYED or to name who decided
    // something; this destroys nothing: there is no prior state, and the row's
    // own created_at is already the durable record that it appeared and when.
    // Nobody decided anything either: the function's guard pins user_id to the
    // session, the status to pending_approval and the role to 'player', so the
    // only content of the act is "somebody signed up", and the decision that
    // follows (approval) IS audited, with the whole signup row as old_value.
    // And since 00132 the row is normally made by ensure_player_for_user at
    // first sign-in, so a row per call here would be a partial census of
    // signups filed under a fallback path. One audit_logs row per member for a
    // fact players.created_at already holds is noise in the log that the
    // entries above have to be found in.
    const { error } = await supabase.rpc('create_player_with_rating', {
      p_user_id: user.id,
      p_email: user.email!,
      p_first_name: profile.first_name,
      p_last_name: profile.last_name,
      p_display_name: profile.display_name || null,
      p_phone: profile.phone || null,
    });

    if (error) {
      Sentry.captureException(error, { extra: { action: 'completeOnboarding', userId: user.id } });
      throw new Error(error.message);
    }

    // Re-fetch for the freshly created row's id.
    playerId = (await options.loadPlayer())?.id ?? null;
    if (playerId) await writeSignupCategory(supabase, playerId, category);
  }

  if (playerId) {
    await insertAcceptances(supabase, playerId, data.age_attestation, options.userAgent);
    await recordPasskeySetup(playerId, data.passkey_setup);
    // AFTER the row exists, and after nothing else depends on it. Ordering is
    // the whole reason this is a separate call rather than a column on the
    // insert above: on the claim path and the existing-player path there is no
    // insert to hang it on, and on all three paths the seed has to inspect the
    // ratings row it is about to overwrite.
    await applySkillTier(playerId, data.skill_tier);
  }

  return { playerId };
}

/**
 * The events answer, written with the MEMBER'S client: the same path Settings
 * uses (updateProfile), so the write-once lock (00129) judges it the same way.
 *
 * "Open events only" is NULL, which is what the column already holds, so
 * nothing is written for it. A claimed roster row an exec already categorised
 * differently is refused by the lock; the exec's value stands and onboarding
 * carries on, because the exec is the one the lock exists to defer to.
 */
async function writeSignupCategory(
  supabase: SupabaseClient,
  playerId: string,
  category: 'mens' | 'womens' | null,
) {
  if (category === null) return;
  const { error } = await supabase
    .from('players')
    .update({ competition_category: category })
    .eq('id', playerId);
  if (!error || isCompetitionCategoryLockedError(error)) return;
  Sentry.captureException(error, { extra: { action: 'writeSignupCategory', playerId } });
  throw new Error(error.message);
}

// Insert acceptance rows for the documents the player is still missing,
// never touching prior rows, which are append-only evidence (00014 dropped
// the unique key so the annual waiver renewal adds a NEW row). Only inserting
// the missing/expired set keeps re-acceptance idempotent in effect.
export async function insertAcceptances(
  supabase: SupabaseClient,
  playerId: string,
  ageAttestation: boolean,
  userAgent: string | null,
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

  // Same inputs as the layout's waiver gate, including the per-player
  // waiver_reset_at, or the two disagree and the accept loop deadlocks
  // (gate shows but this inserts nothing).
  const { data: playerRow } = await supabase
    .from('players')
    .select('waiver_reset_at')
    .eq('id', playerId)
    .maybeSingle();

  const missing = getMissingLegalDocuments(docs, existing ?? [], new Date(), playerRow?.waiver_reset_at ?? null);
  if (missing.length === 0) return;

  const versionByDoc = new Map(docs.map((doc) => [doc.document, doc.version]));
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

/**
 * Store the member's answer to the passkey question (00121).
 *
 * Written with the SERVICE-ROLE client rather than folded into the `players`
 * update above, for two reasons. The column carries no column-level GRANT on
 * purpose (see the migration header) so the member's own client cannot write
 * it; and keeping it out of that update means a problem with this column can
 * never fail the statement that sets onboarding_completed. The member gets in
 * either way.
 *
 * Failures are swallowed for the same reason: the last thing onboarding should
 * do is refuse to finish because an analytics column would not take. Sentry
 * keeps the record.
 */
export async function recordPasskeySetup(playerId: string, outcome: string | undefined) {
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
 * rule that can drift, and the dangerous half ("is this rating safe to
 * overwrite") would be the half running on the client's side of the trust
 * boundary.
 *
 * A TIER NAME IS SENT, NEVER A RATING. The function takes 'beginner' |
 * 'intermediate' | 'advanced'. If this passed an integer into a SECURITY
 * DEFINER function, a hostile client would be able to type itself to the top of
 * the ladder, the same escalation shape 00056 closed on player inserts.
 *
 * Service-role, because that is the only grant the function carries: a
 * SECURITY DEFINER routine that rewrites an arbitrary player's rating is not
 * something a member's own session should be able to reach.
 *
 * Same swallow-and-report contract as recordPasskeySetup. This is the last step
 * of onboarding; a member who has just accepted the waiver and enrolled a
 * passkey must not be bounced back to step three because a rating seed failed.
 * They land at default_elo, exactly where every member landed before tiering
 * existed, and Sentry keeps the record.
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
 * when a rating was actually written (its own comment says the boolean exists
 * "so the caller can tell 'seeded' from 'declined to seed' rather than guessing")
 * and it declines whenever the rating has ever moved or was set deliberately by
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
        // console's audit taxonomy: `tier` belongs to the tournament fee tiers
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

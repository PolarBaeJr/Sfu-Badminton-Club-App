// Discord /signup: the draft, its rules, and the two moments that reach GoTrue.
//
// NO ACCOUNT EXISTS UNTIL EVERY REQUIRED ANSWER IS IN. Each button the member
// presses writes one answer to their row in discord_signup_drafts (00281), and
// the email code is only sent once missingRequirement() finds nothing missing.
// An abandoned or cancelled sign-up leaves a draft that expires, never an auth
// user or a players row.
//
// ONE RULE FOR "WHAT IS STILL NEEDED", used twice: to pick the next screen and
// to refuse a code send. Two lists would drift, and the one guarding the send
// is the one that matters.
//
// NEVER LOG AN ADDRESS, A NAME OR A PHONE NUMBER. Errors here are logged by
// their message only, and the rate-limit ledger holds a digest, not the email.
import { createHash } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import {
  LEGAL_DOCUMENT_LABELS,
  SIGNUP_EVENTS_CHOICES,
  SIGNUP_EVENTS_QUESTION,
  SIGNUP_OTP_TYPES,
  hashDiscordLinkToken,
  isExpectedFailure,
  isSkillTier,
  shouldRetryOtpSend,
  shouldTryNextOtpType,
  sortLegalDocuments,
  type SignupEventsAnswer,
  type WaiverDocument,
} from '@badminton/shared';
import type { createServiceRoleClient } from './supabase-server';
import { getSkillTierOptions, type SkillTierOption } from './rating-tiers';
import { completeOnboardingCore } from './onboarding-core';
import { mintDiscordLinkToken, syncDiscordMembers } from './discord-link';
import { createSignupAuthClient, createSignupMemberClient } from './discord-signup-auth';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

export type SignupDraft = {
  discord_user_id: string;
  email: string;
  first_name: string;
  last_name: string;
  display_name: string | null;
  phone: string | null;
  skill_tier: string | null;
  competition_category: 'mens' | 'womens' | null;
  gender_answered: boolean;
  accepted: Record<string, string>;
  age_attestation: boolean;
  media_consent: boolean | null;
  code_sent_at: string | null;
  send_count: number;
  verify_attempts: number;
  completing_at: string | null;
  created_at: string;
  expires_at: string;
};

export type SignupDocument = { document: WaiverDocument; version: string; content: string };

export type SignupStep =
  | { step: 'details' }
  | { step: 'events' }
  | { step: 'tier' }
  | { step: 'document'; document: WaiverDocument }
  | { step: 'age' }
  | { step: 'consent' };

/** What the bot draws. It writes the buttons; the app decides what is asked. */
export type SignupScreen =
  | {
      kind: 'choice';
      step: 'events' | 'tier' | 'age' | 'consent';
      prompt: string;
      choices: { value: string; label: string }[];
      notice?: string;
    }
  | {
      kind: 'document';
      document: WaiverDocument;
      title: string;
      version: string;
      versionTag: string;
      page: number;
      pageCount: number;
      text: string;
      notice?: string;
    }
  | { kind: 'code_sent' }
  | { kind: 'done'; approved: boolean; linked: boolean }
  // codeSent: an email already went, so "nothing was saved" would not be true.
  | { kind: 'cancelled'; codeSent: boolean };

export type SignupRefusal =
  | 'already_linked'
  | 'timed_out'
  | 'incomplete'
  | 'invalid'
  | 'rate_limited'
  | 'send_failed'
  | 'wrong_code'
  | 'too_many_attempts'
  | 'in_progress'
  | 'existing_account';

export type SignupResult =
  | { ok: true; screen: SignupScreen }
  | { ok: false; refusal: SignupRefusal; message?: string };

/** A read or a write failed. The route answers 503; it is never a refusal. */
export class SignupUnavailableError extends Error {}

export const SIGNUP_DRAFT_MINUTES = 30;
export const SIGNUP_DOCUMENT_PAGE_CHARS = 4000;
export const SIGNUP_USER_AGENT = 'Discord /signup';
const MAX_DRAFTS_PER_DAY = 3;
const MAX_SENDS_PER_DRAFT = 5;
const SEND_COOLDOWN_SECONDS = 60;
const MAX_SENDS_PER_EMAIL_PER_HOUR = 3;
const MAX_VERIFY_ATTEMPTS = 5;
// A verify that died mid-onboarding must not hold the draft forever.
const CLAIM_STALE_MS = 2 * 60_000;
const SEND_RETRY_DELAY_MS = 900;

export const SIGNUP_AGE_PROMPT = "I am 19 or older, or I have my parent/guardian's consent.";
export const SIGNUP_CONSENT_PROMPT =
  'May the club use photos or video of you from club activities on its website and social media? ' +
  'This is optional and never affects your membership. You can change it in Settings at any time.';

/** Sixteen hex characters naming a document version, short enough for a custom_id. */
export function versionTag(version: string): string {
  return createHash('sha256').update(version).digest('hex').slice(0, 16);
}

/** The ledger's key for an address: enough to count by, not enough to read. */
export function emailDigest(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/**
 * Split a document into pages no longer than `limit`, on paragraph boundaries
 * where it can. A paragraph longer than a page is cut on its line breaks, and a
 * line longer than a page is cut where it must be.
 */
export function paginateDocument(content: string, limit = SIGNUP_DOCUMENT_PAGE_CHARS): string[] {
  const pieces: string[] = [];
  for (const paragraph of content.split(/\n{2,}/)) {
    if (paragraph.length <= limit) {
      pieces.push(paragraph);
      continue;
    }
    for (const line of paragraph.split('\n')) {
      for (let start = 0; start < line.length; start += limit) {
        pieces.push(line.slice(start, start + limit));
      }
    }
  }

  const pages: string[] = [];
  let current = '';
  for (const piece of pieces) {
    const joined = current ? `${current}\n\n${piece}` : piece;
    if (joined.length <= limit) {
      current = joined;
    } else {
      if (current) pages.push(current);
      current = piece;
    }
  }
  if (current || pages.length === 0) pages.push(current);
  return pages;
}

/**
 * The first required answer the draft does not have yet, in the order they
 * are asked, or null when the code may be sent.
 *
 * A document counts as accepted only at the version that is current NOW, so a
 * document edited mid-sign-up is asked again. The consent question has to be
 * answered, either way, before the code goes: it is optional, but it is asked.
 */
export function missingRequirement(
  draft: SignupDraft,
  documents: SignupDocument[],
  tiersAvailable: boolean,
): SignupStep | null {
  if (!draft.first_name.trim() || !draft.last_name.trim()) return { step: 'details' };
  if (!draft.gender_answered) return { step: 'events' };
  if (tiersAvailable && !isSkillTier(draft.skill_tier)) return { step: 'tier' };
  for (const doc of sortLegalDocuments(documents)) {
    if (draft.accepted[doc.document] !== doc.version) return { step: 'document', document: doc.document };
  }
  if (!draft.age_attestation) return { step: 'age' };
  if (draft.media_consent === null) return { step: 'consent' };
  return null;
}

export function documentScreen(doc: SignupDocument, page: number, notice?: string): SignupScreen {
  const pages = paginateDocument(doc.content);
  const shown = Math.min(Math.max(page, 0), pages.length - 1);
  return {
    kind: 'document',
    document: doc.document,
    title: LEGAL_DOCUMENT_LABELS[doc.document] ?? doc.document,
    version: doc.version,
    versionTag: versionTag(doc.version),
    page: shown,
    pageCount: pages.length,
    text: pages[shown]!,
    ...(notice ? { notice } : {}),
  };
}

export function stepScreen(
  step: Exclude<SignupStep, { step: 'details' }>,
  documents: SignupDocument[],
  tiers: SkillTierOption[],
  notice?: string,
): SignupScreen {
  const withNotice = notice ? { notice } : {};
  switch (step.step) {
    case 'events':
      return {
        kind: 'choice',
        step: 'events',
        prompt: SIGNUP_EVENTS_QUESTION,
        choices: SIGNUP_EVENTS_CHOICES.map((choice) => ({ value: choice.value, label: choice.label })),
        ...withNotice,
      };
    case 'tier':
      return {
        kind: 'choice',
        step: 'tier',
        prompt:
          'What is your skill level? It sets your starting rating.\n' +
          tiers.map((tier) => `**${tier.label}** (${tier.elo}): ${tier.description}`).join('\n'),
        choices: tiers.map((tier) => ({ value: tier.tier, label: tier.label })),
        ...withNotice,
      };
    case 'document':
      return documentScreen(documents.find((doc) => doc.document === step.document)!, 0, notice);
    case 'age':
      return {
        kind: 'choice',
        step: 'age',
        prompt: SIGNUP_AGE_PROMPT,
        choices: [{ value: 'yes', label: 'I confirm' }],
        ...withNotice,
      };
    case 'consent':
      return {
        kind: 'choice',
        step: 'consent',
        prompt: SIGNUP_CONSENT_PROMPT,
        choices: [
          { value: 'yes', label: 'I consent' },
          { value: 'no', label: 'No thanks' },
        ],
        ...withNotice,
      };
  }
}

// ---------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------

export async function loadSignupDocuments(supabase: ServiceClient): Promise<SignupDocument[]> {
  const { data, error } = await supabase.from('legal_documents').select('document, version, content');
  if (error) {
    console.error('[discord] signup documents read failed:', error.message);
    throw new SignupUnavailableError('legal_documents');
  }
  return sortLegalDocuments((data ?? []) as SignupDocument[]);
}

/** The member's live draft, or null when there is none or it has expired. */
export async function loadDraft(supabase: ServiceClient, discordUserId: string): Promise<SignupDraft | null> {
  const { data, error } = await supabase
    .from('discord_signup_drafts')
    .select('*')
    .eq('discord_user_id', discordUserId)
    .maybeSingle();
  if (error) {
    console.error('[discord] signup draft read failed:', error.message);
    throw new SignupUnavailableError('discord_signup_drafts');
  }
  const draft = data as SignupDraft | null;
  if (!draft) return null;
  if (new Date(draft.expires_at).getTime() <= Date.now()) {
    await deleteDraft(supabase, discordUserId);
    return null;
  }
  return draft;
}

export async function updateDraft(
  supabase: ServiceClient,
  discordUserId: string,
  changes: Partial<SignupDraft>,
): Promise<void> {
  const { error } = await supabase
    .from('discord_signup_drafts')
    .update(changes)
    .eq('discord_user_id', discordUserId);
  if (error) {
    console.error('[discord] signup draft write failed:', error.message);
    throw new SignupUnavailableError('discord_signup_drafts');
  }
}

export async function deleteDraft(supabase: ServiceClient, discordUserId: string): Promise<void> {
  const { error } = await supabase.from('discord_signup_drafts').delete().eq('discord_user_id', discordUserId);
  if (error) {
    console.error('[discord] signup draft delete failed:', error.message);
    throw new SignupUnavailableError('discord_signup_drafts');
  }
}

/** Expired drafts and day-old ledger rows, on every new sign-up. No cron job. */
export async function purgeSignupScratch(supabase: ServiceClient): Promise<void> {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
  const [drafts, attempts] = await Promise.all([
    supabase.from('discord_signup_drafts').delete().lt('expires_at', now.toISOString()),
    supabase.from('discord_signup_attempts').delete().lt('created_at', dayAgo.toISOString()),
  ]);
  // A failed purge costs nothing today; the next sign-up tries again.
  if (drafts.error) console.error('[discord] signup draft purge failed:', drafts.error.message);
  if (attempts.error) console.error('[discord] signup ledger purge failed:', attempts.error.message);
}

async function countAttempts(
  supabase: ServiceClient,
  filter: { column: 'discord_user_id' | 'email_digest'; value: string },
  kind: 'draft' | 'send',
  since: Date,
): Promise<number> {
  const { count, error } = await supabase
    .from('discord_signup_attempts')
    .select('id', { count: 'exact', head: true })
    .eq(filter.column, filter.value)
    .eq('kind', kind)
    .gte('created_at', since.toISOString());
  if (error) {
    console.error('[discord] signup ledger read failed:', error.message);
    throw new SignupUnavailableError('discord_signup_attempts');
  }
  return count ?? 0;
}

async function recordAttempt(
  supabase: ServiceClient,
  discordUserId: string,
  kind: 'draft' | 'send',
  digest: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('discord_signup_attempts')
    .insert({ discord_user_id: discordUserId, kind, email_digest: digest });
  if (error) {
    console.error('[discord] signup ledger write failed:', error.message);
    throw new SignupUnavailableError('discord_signup_attempts');
  }
}

/** Whether this Discord account may start another sign-up today. */
export async function draftAllowed(supabase: ServiceClient, discordUserId: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const used = await countAttempts(supabase, { column: 'discord_user_id', value: discordUserId }, 'draft', since);
  return used < MAX_DRAFTS_PER_DAY;
}

/**
 * Start (or restart) the draft. EVERY column is written, so a second /signup
 * starts clean rather than inheriting the first one's accepted documents,
 * answers or code.
 */
export async function startDraft(
  supabase: ServiceClient,
  discordUserId: string,
  details: { email: string; first_name: string; last_name: string; display_name: string | null; phone: string | null },
): Promise<SignupDraft> {
  const now = new Date();
  const draft: SignupDraft = {
    discord_user_id: discordUserId,
    ...details,
    skill_tier: null,
    competition_category: null,
    gender_answered: false,
    accepted: {},
    age_attestation: false,
    media_consent: null,
    code_sent_at: null,
    send_count: 0,
    verify_attempts: 0,
    completing_at: null,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + SIGNUP_DRAFT_MINUTES * 60_000).toISOString(),
  };
  const { error } = await supabase.from('discord_signup_drafts').upsert(draft, { onConflict: 'discord_user_id' });
  if (error) {
    console.error('[discord] signup draft start failed:', error.message);
    throw new SignupUnavailableError('discord_signup_drafts');
  }
  await recordAttempt(supabase, discordUserId, 'draft', null);
  return draft;
}

/**
 * The next screen for a draft: the first thing still missing, or, with nothing
 * missing, the code (sent now if it has not been already).
 */
export async function advance(supabase: ServiceClient, draft: SignupDraft, notice?: string): Promise<SignupResult> {
  const [documents, tiers] = await Promise.all([loadSignupDocuments(supabase), getSkillTierOptions(supabase)]);
  const missing = missingRequirement(draft, documents, tiers.length > 0);
  if (missing?.step === 'details') return { ok: false, refusal: 'incomplete' };
  if (missing) return { ok: true, screen: stepScreen(missing, documents, tiers, notice) };
  if (draft.code_sent_at) return { ok: true, screen: { kind: 'code_sent' } };
  return sendSignupCode(supabase, draft, documents, tiers);
}

// ---------------------------------------------------------------------------
// The code
// ---------------------------------------------------------------------------

/**
 * Email the code. Refuses, and sends nothing, while any required answer is
 * missing, however the request arrived.
 *
 * shouldCreateUser is TRUE here, unlike the web sign-in: this is the sign-up,
 * and the auth user it creates stays unconfirmed (and unable to sign in) until
 * the code comes back. The web's one silent retry on an idle-gateway 503 is
 * kept.
 */
export async function sendSignupCode(
  supabase: ServiceClient,
  draft: SignupDraft,
  documents?: SignupDocument[],
  tiers?: SkillTierOption[],
): Promise<SignupResult> {
  const currentDocuments = documents ?? (await loadSignupDocuments(supabase));
  const currentTiers = tiers ?? (await getSkillTierOptions(supabase));
  const missing = missingRequirement(draft, currentDocuments, currentTiers.length > 0);
  if (missing?.step === 'details') return { ok: false, refusal: 'incomplete' };
  if (missing) return { ok: true, screen: stepScreen(missing, currentDocuments, currentTiers) };

  if (draft.send_count >= MAX_SENDS_PER_DRAFT) {
    return { ok: false, refusal: 'rate_limited', message: 'That is as many codes as one sign-up can send. Run /signup again later.' };
  }
  if (draft.code_sent_at && Date.now() - new Date(draft.code_sent_at).getTime() < SEND_COOLDOWN_SECONDS * 1000) {
    return { ok: false, refusal: 'rate_limited', message: 'A code was sent less than a minute ago. Wait a minute before asking for another.' };
  }
  const digest = emailDigest(draft.email);
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  if ((await countAttempts(supabase, { column: 'email_digest', value: digest }, 'send', hourAgo)) >= MAX_SENDS_PER_EMAIL_PER_HOUR) {
    return { ok: false, refusal: 'rate_limited', message: 'Too many codes have gone to that address in the last hour. Try again later.' };
  }
  await recordAttempt(supabase, draft.discord_user_id, 'send', digest);

  const auth = createSignupAuthClient();
  const request = () => auth.auth.signInWithOtp({ email: draft.email, options: { shouldCreateUser: true } });
  let { error } = await request();
  if (error && shouldRetryOtpSend(error)) {
    await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_DELAY_MS));
    ({ error } = await request());
  }
  if (error) {
    console.error('[discord] signup code send failed:', error.status ?? 'no status');
    if (/rate|after \d|security purposes|too many/i.test(error.message ?? '')) {
      return { ok: false, refusal: 'rate_limited', message: 'Too many codes were asked for just now. Wait a few minutes and press Resend.' };
    }
    return { ok: false, refusal: 'send_failed' };
  }

  await updateDraft(supabase, draft.discord_user_id, {
    code_sent_at: new Date().toISOString(),
    send_count: draft.send_count + 1,
  });
  return { ok: true, screen: { kind: 'code_sent' } };
}

const PLAYER_SELECT = '*, ratings(*), waiver_acceptances(document, version, accepted_at)';

/**
 * Check the code and, if it is right, make the account exactly as web
 * onboarding does, link this Discord account to it, and sign the session out.
 *
 * THE ORDER IS THE SAFETY. Attempts are counted before the code is tried, so
 * guessing costs a draft. The answers are re-checked against the CURRENT
 * documents before the code is spent, so a document edited mid-sign-up is
 * shown again rather than recorded at a version the member never read. The
 * draft is claimed before anything is created, so a double submit makes one
 * account.
 */
export async function verifySignup(
  supabase: ServiceClient,
  draft: SignupDraft,
  code: string,
): Promise<SignupResult> {
  const discordUserId = draft.discord_user_id;
  if (!draft.code_sent_at) return advance(supabase, draft);

  if (draft.verify_attempts >= MAX_VERIFY_ATTEMPTS) {
    await deleteDraft(supabase, discordUserId);
    return { ok: false, refusal: 'too_many_attempts' };
  }
  await updateDraft(supabase, discordUserId, { verify_attempts: draft.verify_attempts + 1 });

  const [documents, tiers] = await Promise.all([loadSignupDocuments(supabase), getSkillTierOptions(supabase)]);
  const missing = missingRequirement(draft, documents, tiers.length > 0);
  if (missing?.step === 'details') return { ok: false, refusal: 'incomplete' };
  if (missing) {
    // Nothing recorded, and the code is not spent: once they accept again the
    // same code still works.
    const notice =
      missing.step === 'document'
        ? `The ${LEGAL_DOCUMENT_LABELS[missing.document] ?? missing.document} changed while you were signing up. Please read it again.`
        : undefined;
    return { ok: true, screen: stepScreen(missing, documents, tiers, notice) };
  }

  const cutoff = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from('discord_signup_drafts')
    .update({ completing_at: new Date().toISOString() })
    .eq('discord_user_id', discordUserId)
    .or(`completing_at.is.null,completing_at.lt.${cutoff}`)
    .select('discord_user_id');
  if (claimError) {
    console.error('[discord] signup claim failed:', claimError.message);
    throw new SignupUnavailableError('discord_signup_drafts');
  }
  if (!claimed || claimed.length === 0) return { ok: false, refusal: 'in_progress' };
  const release = () => updateDraft(supabase, discordUserId, { completing_at: null });

  const auth = createSignupAuthClient();
  let session: { access_token: string } | null = null;
  let user: { id: string; email?: string | null } | null = null;
  let lastMessage = '';
  for (const type of SIGNUP_OTP_TYPES) {
    const { data, error } = await auth.auth.verifyOtp({ email: draft.email, token: code, type });
    if (!error && data.session && data.user) {
      session = data.session;
      user = data.user;
      break;
    }
    lastMessage = error?.message ?? '';
    if (!shouldTryNextOtpType(lastMessage)) break;
  }
  if (!session || !user) {
    await release();
    if (shouldTryNextOtpType(lastMessage)) return { ok: false, refusal: 'wrong_code' };
    console.error('[discord] signup verify failed');
    throw new SignupUnavailableError('verifyOtp');
  }

  try {
    const loadPlayer = async () => {
      const { data, error } = await supabase.from('players').select(PLAYER_SELECT).eq('user_id', user!.id).maybeSingle();
      if (error) throw new Error(error.message);
      return data as (Record<string, unknown> & { id: string; first_name?: string | null }) | null;
    };

    // An address that already belongs to a member. Nothing is created and
    // nothing is linked: the member signs in on the web and runs /link, which
    // proves they hold the account rather than just the inbox.
    const existing = await loadPlayer();
    if (existing?.onboarding_completed === true) {
      await deleteDraft(supabase, discordUserId);
      return { ok: false, refusal: 'existing_account' };
    }

    const member = createSignupMemberClient(session.access_token);
    let playerId: string | null;
    try {
      ({ playerId } = await completeOnboardingCore(
        member,
        user,
        {
          first_name: draft.first_name,
          last_name: draft.last_name,
          display_name: draft.display_name ?? undefined,
          phone: draft.phone ?? undefined,
          event_category: (draft.competition_category ?? 'open') as SignupEventsAnswer,
          waiver_accepted: true,
          code_of_conduct_accepted: true,
          terms_accepted: true,
          age_attestation: draft.age_attestation,
          // 'unsupported' per 00121: the client cannot do WebAuthn and nothing was refused.
          // 'unavailable' is reserved for a deployment that cannot enrol.
          passkey_setup: 'unsupported',
          skill_tier: isSkillTier(draft.skill_tier) ? draft.skill_tier : undefined,
        },
        { userAgent: SIGNUP_USER_AGENT, loadPlayer },
      ));
    } catch (err) {
      if (isExpectedFailure(err)) {
        await deleteDraft(supabase, discordUserId);
        return { ok: false, refusal: 'invalid', message: (err as Error).message };
      }
      // The code is spent but the draft is kept and released, so Resend and a
      // fresh code can finish it.
      await release();
      throw err;
    }
    if (!playerId) {
      await release();
      throw new Error('Onboarding finished without a player row');
    }

    // Optional, and the member's own client, as Settings does it. A failure
    // here does not undo the account; the member can switch it on in Settings.
    if (draft.media_consent === true) {
      const { error } = await member.rpc('set_my_media_consent', { p_consent: true });
      if (error) Sentry.captureException(new Error(error.message), { extra: { action: 'discordSignupConsent', playerId } });
    }

    // Linked the way /link links: a token minted for this Discord account and
    // consumed by the MEMBER, so 00165's own checks decide, and no link row is
    // ever written by hand.
    let linked = false;
    const minted = await mintDiscordLinkToken(supabase, discordUserId, null);
    if (minted.ok) {
      const { error } = await member.rpc('consume_discord_link_token', {
        p_token_hash: await hashDiscordLinkToken(minted.token),
      });
      if (error) {
        Sentry.captureException(new Error(error.message), { extra: { action: 'discordSignupLink', playerId } });
      } else {
        linked = true;
      }
    } else {
      Sentry.captureException(new Error(minted.error), { extra: { action: 'discordSignupMint', playerId } });
    }
    if (linked) await syncDiscordMembers([discordUserId], 'linked');

    const { data: created } = await supabase.from('players').select('status').eq('id', playerId).maybeSingle();
    await deleteDraft(supabase, discordUserId);
    return {
      ok: true,
      screen: { kind: 'done', approved: !!created && created.status !== 'pending_approval', linked },
    };
  } finally {
    // The session existed only to act as the member for this one request.
    try {
      await auth.auth.signOut({ scope: 'local' });
    } catch (err) {
      Sentry.captureException(err, { extra: { action: 'discordSignupSignOut' } });
    }
  }
}

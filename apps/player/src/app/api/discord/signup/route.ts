import { NextResponse } from 'next/server';
import {
  categoryFromSignupAnswer,
  isSkillTier,
  onboardingProfileSchema,
  type WaiverDocument,
} from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';
import {
  SignupUnavailableError,
  advance,
  deleteDraft,
  documentScreen,
  draftAllowed,
  loadDraft,
  loadSignupDocuments,
  purgeSignupScratch,
  sendSignupCode,
  startDraft,
  updateDraft,
  verifySignup,
  versionTag,
  type SignupResult,
} from '@/lib/discord-signup';

export const dynamic = 'force-dynamic';

// Discord /signup: one POST per button, each carrying an `action`.
//
// The caller is the Discord id the bot read off the interaction. Every answer
// is written to that account's draft (00281) and the reply is the next screen
// for the bot to draw; lib/discord-signup.ts holds the rules. Nothing is
// created until `verify` succeeds.
//
// NO "IS THIS ADDRESS TAKEN?" ANSWER, at any step. Telling a stranger in
// Discord whether an email belongs to a member is the enumeration the web
// sign-in refuses to offer too. An existing member only finds out after
// proving the inbox is theirs, at verify.
//
// A REFUSAL IS A 200 WITH A CODE, as on the other /api/discord routes. A
// failed read or write is a 503, never a refusal.

const SNOWFLAKE = /^\d{5,25}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE = /^\d{6,10}$/;
const DOCUMENTS: WaiverDocument[] = ['terms_of_use', 'privacy_policy', 'waiver', 'code_of_conduct'];

function reply(result: SignupResult) {
  return NextResponse.json(result);
}

const TIMED_OUT: SignupResult = { ok: false, refusal: 'timed_out' };

export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const str = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string).trim() : '');
  const discordUserId = str('discordUserId');
  const action = str('action');
  if (!SNOWFLAKE.test(discordUserId)) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const supabase = createServiceRoleClient();
  try {
    if (action === 'details') return reply(await details(supabase, discordUserId, str));

    const draft = await loadDraft(supabase, discordUserId);
    if (!draft) return reply(TIMED_OUT);

    switch (action) {
      case 'cancel':
        await deleteDraft(supabase, discordUserId);
        return reply({ ok: true, screen: { kind: 'cancelled', codeSent: !!draft.code_sent_at } });

      case 'events': {
        const answer = str('answer');
        if (answer !== 'mens' && answer !== 'womens' && answer !== 'open') break;
        const changes = {
          gender_answered: true,
          competition_category: categoryFromSignupAnswer(answer),
        };
        await updateDraft(supabase, discordUserId, changes);
        return reply(await advance(supabase, { ...draft, ...changes }));
      }

      case 'tier': {
        const tier = str('tier');
        if (!isSkillTier(tier)) break;
        await updateDraft(supabase, discordUserId, { skill_tier: tier });
        return reply(await advance(supabase, { ...draft, skill_tier: tier }));
      }

      case 'page': {
        const documents = await loadSignupDocuments(supabase);
        const doc = documents.find((candidate) => candidate.document === str('document'));
        const page = payload.page;
        if (!doc || typeof page !== 'number' || !Number.isInteger(page)) break;
        return reply({ ok: true, screen: documentScreen(doc, page) });
      }

      case 'accept': {
        const document = str('document') as WaiverDocument;
        if (!DOCUMENTS.includes(document)) break;
        const documents = await loadSignupDocuments(supabase);
        const doc = documents.find((candidate) => candidate.document === document);
        if (!doc) return reply(await advance(supabase, draft));
        // Accepted at the version the member was SHOWN. If it changed since,
        // they read it again from the top.
        if (str('versionTag') !== versionTag(doc.version)) {
          return reply({
            ok: true,
            screen: documentScreen(doc, 0, 'This document changed while you were reading it. Please read it again.'),
          });
        }
        const accepted = { ...draft.accepted, [document]: doc.version };
        await updateDraft(supabase, discordUserId, { accepted });
        return reply(await advance(supabase, { ...draft, accepted }));
      }

      case 'age':
        await updateDraft(supabase, discordUserId, { age_attestation: true });
        return reply(await advance(supabase, { ...draft, age_attestation: true }));

      case 'consent': {
        if (typeof payload.consent !== 'boolean') break;
        const mediaConsent = payload.consent;
        await updateDraft(supabase, discordUserId, { media_consent: mediaConsent });
        return reply(await advance(supabase, { ...draft, media_consent: mediaConsent }));
      }

      case 'resend':
        return reply(await sendSignupCode(supabase, draft));

      // Where the member is, for the bot to redraw after it lost an answer.
      case 'resume':
        return reply(await advance(supabase, draft));

      case 'verify': {
        const code = str('code').replace(/\s+/g, '');
        if (!CODE.test(code)) {
          return reply({ ok: false, refusal: 'invalid', message: 'Enter the code from the email, digits only.' });
        }
        return reply(await verifySignup(supabase, draft, code));
      }
    }
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  } catch (err) {
    if (err instanceof SignupUnavailableError) {
      return NextResponse.json({ error: 'signup_unavailable' }, { status: 503 });
    }
    throw err;
  }
}

async function details(
  supabase: ReturnType<typeof createServiceRoleClient>,
  discordUserId: string,
  str: (key: string) => string,
): Promise<SignupResult> {
  // Already a member here. /signup would make a second account for one person.
  const { data: link, error: linkError } = await supabase
    .from('player_discord_links')
    .select('discord_user_id')
    .eq('discord_user_id', discordUserId)
    .maybeSingle();
  if (linkError) {
    console.error('[discord] signup link precheck failed:', linkError.message);
    throw new SignupUnavailableError('player_discord_links');
  }
  if (link) return { ok: false, refusal: 'already_linked' };

  const email = str('email').toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) {
    return { ok: false, refusal: 'invalid', message: 'That email address does not look right.' };
  }
  // The same rules the web onboarding form applies to the same fields. The
  // events answer is asked on the next screen, so a placeholder stands in.
  const parsed = onboardingProfileSchema.safeParse({
    first_name: str('firstName'),
    last_name: str('lastName'),
    display_name: str('displayName'),
    phone: str('phone'),
    event_category: 'open',
  });
  if (!parsed.success) {
    return { ok: false, refusal: 'invalid', message: parsed.error.issues[0]?.message ?? 'Check your details.' };
  }

  await purgeSignupScratch(supabase);
  if (!(await draftAllowed(supabase, discordUserId))) {
    return {
      ok: false,
      refusal: 'rate_limited',
      message: 'That is as many sign-ups as one Discord account can start in a day. Try again tomorrow, or sign up on the website.',
    };
  }

  const draft = await startDraft(supabase, discordUserId, {
    email,
    first_name: parsed.data.first_name.trim(),
    last_name: parsed.data.last_name,
    display_name: parsed.data.display_name ?? null,
    phone: parsed.data.phone ?? null,
  });
  return advance(supabase, draft);
}

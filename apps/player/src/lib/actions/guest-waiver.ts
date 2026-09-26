'use server';

import * as Sentry from '@sentry/nextjs';
import { createHmac, randomBytes } from 'node:crypto';
import { headers } from 'next/headers';
import {
  ExpectedError,
  featureAccessFor,
  featureGate,
  featureOffMessage,
  guestMediaConsentSchema,
  guestWaiverSchema,
  parseOrThrow,
  raise,
} from '@badminton/shared';
import { createServiceRoleClient, getViewer } from '../supabase-server';
import { getFeatureFlags } from '../feature-gate';
import { runAction, type ActionResult } from './_shared';

// A GUEST SIGNS THE WAIVER AND PRIVACY POLICY (00254).
//
// The one action in this app a visitor with no account can call, so every
// input is a client-controlled POST field and only the name, the email and the
// two ticks are read. The versions come from the database, the token from
// here, and the IP from the request headers, never from the form.
//
// NO EMAIL, NO ACCOUNT LOOKUP, NO MERGING. Sending mail from an anonymous form
// would hand anybody a way to make the club email a stranger, and matching the
// email to an account would let anybody attach a signing to an address they
// typed.

// Stands in for Tables<'guest_waiver_signings'> until database.gen.ts is
// regenerated from a database that has 00254.
// TODO: replace with the generated row type once prod has 00254.
export type GuestWaiverSigning = {
  token: string;
  full_name: string;
  accepted_at: string;
  waiver_version: string;
  privacy_version: string;
  reused: boolean;
  // 00255. Set by a second call after the signing; media_consent_saved is
  // false when that call failed and the signing stands without it.
  media_consent: boolean;
  media_consent_saved: boolean;
};

// Stands in for the generated return type of set_guest_media_consent, absent
// from database.gen.ts like the rest of 00254's objects.
type GuestMediaConsentRow = { media_consent: boolean; media_consent_changed_at: string | null };

// The HINTs sign_guest_waiver raises with, in words a guest can act on.
const REFUSALS: Record<string, string> = {
  guest_waiver_email_limit:
    'Too many signings from this email today. Please speak to a club executive.',
  guest_waiver_ip_limit:
    'Too many signings from this network in the last hour. Please try again later or speak to a club executive.',
  guest_waiver_no_document: 'The waiver is not available right now. Please try again later.',
  guest_waiver_age: 'You must be 19 or older to sign as a guest.',
};

let warnedNoSalt = false;

function clientIp(h: Headers): string {
  const cf = h.get('cf-connecting-ip')?.trim();
  if (cf) return cf;
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
}

// Never an unsalted hash: sha256 of an IPv4 address is reversed by trying all
// four billion. Without the salt the IP throttle is skipped and the email
// throttle still runs.
function ipHash(ip: string): string | null {
  const salt = process.env.GUEST_WAIVER_IP_SALT;
  if (!salt || !ip) {
    if (!salt && !warnedNoSalt) {
      warnedNoSalt = true;
      console.warn('[guest-waiver] GUEST_WAIVER_IP_SALT is not set, so the per-IP throttle is off');
    }
    return null;
  }
  return createHmac('sha256', salt).update(ip).digest('hex');
}

export async function signGuestWaiver(input: unknown): Promise<ActionResult<GuestWaiverSigning>> {
  return runAction(() => signGuestWaiverImpl(input));
}

async function signGuestWaiverImpl(input: unknown): Promise<GuestWaiverSigning> {
  const parsed = parseOrThrow(guestWaiverSchema, input);

  // Not assertFeatureOn: that expects the row requirePlayer() returns, and a
  // guest has none. featureAccessFor(null) holds no key, so a guest is refused
  // while the switch is off and a signed-in key holder can still try it.
  const [flags, viewer] = await Promise.all([
    getFeatureFlags(),
    getViewer().catch(() => ({ user: null, player: null })),
  ]);
  if (featureGate(flags.guest_waivers, featureAccessFor(viewer.player).includes('guest_waivers')) === 'redirect') {
    throw new ExpectedError(featureOffMessage('guest_waivers'));
  }

  const h = await headers();
  const { data, error } = await createServiceRoleClient().rpc('sign_guest_waiver', {
    p_full_name: parsed.full_name,
    p_email: parsed.email,
    p_age_attestation: true,
    p_user_agent: h.get('user-agent'),
    p_ip_hash: ipHash(clientIp(h)),
    p_token: randomBytes(24).toString('hex'),
  });
  if (error) {
    const refusal = error.hint ? REFUSALS[error.hint] : undefined;
    if (refusal) throw new ExpectedError(refusal);
    throw raise('DB-000', error, 'Your signing could not be saved. Please try again.');
  }
  const row = (data as Omit<GuestWaiverSigning, 'media_consent' | 'media_consent_saved'>[] | null)?.[0];
  if (!row) throw raise('DB-000', new Error('sign_guest_waiver returned no row'));

  // ALWAYS, not only when ticked. A repeat signing within ten minutes returns
  // the existing row, so an untick on the repeat has to turn consent off.
  // A failure here never undoes the signing: the guest is told, and can set
  // it from the proof page.
  const consent = await guestMediaConsentRpc(row.token, parsed.media_consent);
  if (consent.error) {
    Sentry.captureException(consent.error, { extra: { action: 'signGuestWaiver.media_consent' } });
    return { ...row, media_consent: false, media_consent_saved: false };
  }
  return { ...row, media_consent: consent.row.media_consent, media_consent_saved: true };
}

async function guestMediaConsentRpc(
  token: string,
  consent: boolean,
): Promise<{ row: GuestMediaConsentRow; error: null } | { row: null; error: { message: string; hint?: string | null } }> {
  const { data, error } = await createServiceRoleClient().rpc('set_guest_media_consent', {
    p_token: token,
    p_consent: consent,
  });
  if (error) return { row: null, error };
  const row = (data as GuestMediaConsentRow[] | null)?.[0];
  if (!row) return { row: null, error: { message: 'set_guest_media_consent returned no row' } };
  return { row, error: null };
}

// A guest changes their photo and video consent from the proof page.
//
// NOT BEHIND THE FEATURE SWITCH, like the proof page itself: a proof already
// handed out must keep working, and so must a withdrawal.
export async function setGuestMediaConsent(
  input: unknown,
): Promise<ActionResult<{ consent: boolean; changedAt: string | null }>> {
  return runAction(async () => {
    const parsed = parseOrThrow(guestMediaConsentSchema, input);
    const { row, error } = await guestMediaConsentRpc(parsed.token, parsed.media_consent);
    if (error) {
      if (error.hint === 'guest_media_consent_not_found') {
        throw new ExpectedError('This proof link is not valid.');
      }
      throw raise('DB-000', error, 'Your choice could not be saved. Please try again.');
    }
    return { consent: row.media_consent, changedAt: row.media_consent_changed_at ?? null };
  });
}

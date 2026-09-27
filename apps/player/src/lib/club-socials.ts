import { cache } from 'react';
import {
  CLUB_SOCIALS_SETTING_KEY,
  MEMBERSHIP_PAYMENTS_SETTING_KEY,
  parseClubSocials,
  parseMembershipPaymentSettings,
  type ClubSocials,
  type MembershipPaymentSettings,
} from '@badminton/shared';
import { createServiceRoleClient } from './supabase-server';

// THE CLUB LINKS, ON THE MEMBERS' SIDE. The rules are in packages/shared
// (club-socials.ts, membership-settings.ts); this is where they meet a request.
//
// getClubSocials() RUNS IN THE ROOT LAYOUT, so it must never throw: a throw
// there is a 500 on every page of the site. Mirrors getFeatureFlags(): once per
// request through react cache(), read with the service-role client because the
// footer renders for signed-out visitors and settings_select is `TO
// authenticated`, and a failed read of any kind falls back to the defaults, so
// a settings blip leaves the Discord and Instagram links where they were.

async function readSetting(key: string): Promise<unknown> {
  try {
    const { data, error } = await createServiceRoleClient()
      .from('platform_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) {
      console.error(`[club-links] could not read ${key}, using the defaults:`, error.message);
      return null;
    }
    return data?.value ?? null;
  } catch (err) {
    console.error(`[club-links] could not read ${key}, using the defaults:`, err);
    return null;
  }
}

/** The social links, once per request. Never throws. */
export const getClubSocials = cache(async (): Promise<ClubSocials> => {
  return parseClubSocials(await readSetting(CLUB_SOCIALS_SETTING_KEY));
});

/** Where a membership is bought, once per request. Never throws. */
export const getMembershipPayments = cache(async (): Promise<MembershipPaymentSettings> => {
  return parseMembershipPaymentSettings(await readSetting(MEMBERSHIP_PAYMENTS_SETTING_KEY));
});

import { NextResponse } from 'next/server';
import { readFeatureFlags } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { getClubSocials } from '@/lib/club-socials';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// The club's links, for the bot's /socials command.
//
// THE SAME ROW AND THE SAME RULES AS THE WEBSITE'S FOOTER. getClubSocials()
// re-checks every stored value, so the bot can only ever print a link the site
// would print. The bot adds the invite URL itself: it is a constant on both
// sides, and sending it from here would only give it a second place to drift.
//
// `enabled` is the socials feature switch. There is no page.access key to
// honour here: the bot answers a whole server, not one member.
export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let enabled = true;
  try {
    enabled = (await readFeatureFlags(createServiceRoleClient())).socials;
  } catch {
    // readFeatureFlags never throws; building the client can. A failed read is
    // "on", the same as every other feature switch.
  }
  if (!enabled) {
    return NextResponse.json({ enabled: false, showDiscord: false, instagramUrl: null });
  }

  const socials = await getClubSocials();
  return NextResponse.json({
    enabled: true,
    showDiscord: socials.showDiscord,
    instagramUrl: socials.instagramUrl,
  });
}

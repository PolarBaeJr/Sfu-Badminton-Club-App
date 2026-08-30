import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';
import { resolveProfile, type ProfileTarget } from '@/lib/discord-profile';
import { mintCardToken } from '@/lib/discord-card-token';

export const dynamic = 'force-dynamic';

// The profile card's data, plus the token that names its PNG.
//
// THE BOT NEVER TALKS TO THE DATABASE, so this is where /profile's three
// lookups are decided. All three end at the same resolver, which owns the
// visibility rules — see lib/discord-profile.ts.
//
// DISCORD IDS ARRIVE AS HEADERS, NEVER QUERY PARAMS, the same rule the rest of
// this surface follows: ids in a URL end up in the access log. `handle` is a
// query param because it is a public display name that /leaderboard already
// prints into a channel, not an account identifier.
export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const callerId = request.headers.get('x-discord-user-id');
  const targetId = request.headers.get('x-discord-target-id');
  const handle = new URL(request.url).searchParams.get('handle');

  // Most specific first. A caller who typed a handle meant the handle even if
  // they also mentioned somebody; the bot only ever sends one.
  const target: ProfileTarget | null = handle
    ? { by: 'handle', value: handle }
    : targetId
      ? { by: 'discordUserId', value: targetId }
      : callerId
        ? { by: 'discordUserId', value: callerId }
        : null;

  if (!target) {
    return NextResponse.json({ error: 'no_target' }, { status: 400 });
  }

  try {
    const result = await resolveProfile(target);

    if ('miss' in result) {
      // The bot turns each of these into its own sentence. Distinguished here
      // and not collapsed, because "you haven't linked yet" and "that member
      // hasn't linked yet" send the member to two different places.
      //
      // `not_linked` only ever describes the CALLER: it is reported when the
      // resolver was given the caller's own id, which happens only when no
      // handle and no mention were supplied.
      const miss =
        result.miss === 'not_linked' && (handle || targetId)
          ? 'target_unlinked'
          : result.miss;
      return NextResponse.json({ error: miss }, { status: 404 });
    }

    const cardToken = mintCardToken(result.profile.id);
    if (!cardToken) {
      // Only reachable with DISCORD_SERVICE_SECRET unset, which this request
      // could not have got past. Kept so a future caller cannot get a payload
      // with a null token and render a broken embed.
      return NextResponse.json({ error: 'card_unavailable' }, { status: 503 });
    }

    return NextResponse.json({ profile: result.profile, cardToken });
  } catch (error) {
    Sentry.captureException(error, { extra: { route: 'discord/profile' } });
    return NextResponse.json({ error: 'profile_unavailable' }, { status: 502 });
  }
}

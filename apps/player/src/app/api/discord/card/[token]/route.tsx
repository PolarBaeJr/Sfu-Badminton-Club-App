import { ImageResponse } from 'next/og';
import { readCardToken } from '@/lib/discord-card-token';
import { resolveProfile } from '@/lib/discord-profile';
import { Card, FONTS, W, cardHeight, avatarDataUri } from '@/lib/discord-card';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The profile card, as a PNG.
 *
 * ANONYMOUS ON PURPOSE, and the only route under /api/discord that is. Discord
 * does not hand the embed's image URL to the member's browser -- its CDN
 * fetches it server-side, with no session and no service secret -- so a route
 * behind either would render a broken image in every channel. The token in the
 * path is what authorises the request; see lib/discord-card-token.ts for why
 * the player id is inside the signature rather than beside it.
 *
 * IT IS ALSO OUTSIDE THE MIDDLEWARE MATCHER (see middleware.ts), which is what
 * makes "anonymous" true rather than aspirational -- the matcher would
 * otherwise redirect it to /login and Discord would cache the redirect.
 */

/** One 404, no body, for every reason a token can fail. See readCardToken. */
const gone = () => new Response(null, { status: 404 });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const playerId = readCardToken(token);
  if (!playerId) return gone();

  // Re-read rather than carrying the numbers in the token: a card fetched a
  // week after it was posted should show what is true now, and a token that
  // carried its own data would be a signed snapshot nobody could correct.
  // withForm: this is the only caller that draws recent form -- see
  // ResolveOptions. The bot's own route asks for the profile without it.
  const result = await resolveProfile({ by: 'playerId', value: playerId }, { withForm: true });
  if ('miss' in result) return gone();

  const avatar = await avatarDataUri(result.profile.avatarUrl);

  return new ImageResponse(<Card profile={result.profile} avatar={avatar} />, {
    width: W,
    // The renderer's own answer, not a constant: an unranked card is shorter
    // because it has less on it. See cardHeight.
    height: cardHeight(result.profile),
    fonts: FONTS,
    headers: {
      // Discord's CDN caches what it fetched anyway; this keeps a member who
      // re-runs /profile after a match from being served yesterday's numbers by
      // anything in between.
      'cache-control': 'public, max-age=300',
    },
  });
}

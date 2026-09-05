import { ImageResponse } from 'next/og';
import { readCardToken } from '@/lib/discord-card-token';
import { parseLadderFocus } from '@/lib/discord-profile';
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
  request: Request,
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

  // WHICH LADDER TO HEADLINE, from `/profile type:`. Re-validated here against
  // the same fixed list of four rather than trusted: this arrives as a query
  // parameter, so it is whatever the caller typed, and Discord's own choice
  // list constrains only the well-behaved path. Anything else parses to null
  // and the card draws its default table -- there is no input that can make
  // this route say more about a member than the token already allows, because
  // the focus only picks WHICH of the already-resolved ranks is drawn large.
  const focus = parseLadderFocus(new URL(request.url).searchParams.get('type'));

  return new ImageResponse(<Card profile={result.profile} avatar={avatar} focus={focus} />, {
    width: W,
    // The renderer's own answer, not a constant: an unranked card is shorter
    // because it has less on it. See cardHeight.
    height: cardHeight(result.profile),
    fonts: FONTS,
    headers: {
      // RENDERING THIS IS THE EXPENSIVE PART OF THE FEATURE. satori lays the
      // card out and resvg encodes the PNG, both on the one Next.js thread that
      // is already this app's throughput ceiling -- so every fetch served from
      // a cache instead is a request the club's own box does not spend ~100ms
      // of CPU on. A posted card is fetched once per viewer who scrolls past
      // it, which makes the hit rate high and the saving real.
      //
      // WHAT THE WINDOW COSTS is bounded and small: /profile mints a fresh
      // token every time it is run, so a member who wants current numbers gets
      // a new URL and a new render no matter what this says. The window only
      // governs re-fetches of a card ALREADY POSTED, where the alternative is
      // re-rendering an image whose numbers nobody is watching change.
      //
      // s-maxage names the shared caches (Discord's CDN, the club's proxy)
      // separately from any browser that reaches the URL directly, and
      // stale-while-revalidate lets an edge answer instantly from a slightly
      // old copy while it refreshes behind the request rather than making a
      // viewer wait for a render.
      'cache-control': 'public, max-age=900, s-maxage=900, stale-while-revalidate=3600',
    },
  });
}

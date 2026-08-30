import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The opaque name of a profile card.
 *
 * The card is a PNG that Discord fetches ANONYMOUSLY — its CDN, not the member,
 * makes that request, so the route cannot be behind a session and cannot be
 * behind the service secret either. What stops it being a public dump of the
 * roster is that the only way to name a card is to hold a signature this module
 * produced, and the only thing that produces one is /api/discord/profile, which
 * IS behind the service secret.
 *
 * So: the player id is INSIDE the signed payload, never a separate parameter
 * alongside it. An unsigned `?player=` next to a signed token is the classic
 * hole — the signature would then attest to nothing the caller could not change.
 *
 * KEYED ON DISCORD_SERVICE_SECRET on purpose. It is already present in the
 * player container (isAuthorizedDiscordService reads it), already rotates as one
 * unit with the rest of the Discord surface, and adding a second secret would
 * mean a deploy where one landed and the other did not.
 */

/**
 * Seven days.
 *
 * Discord proxies the image through media.discordapp.net and caches what it
 * fetched, so an expired token does not blank out a card already posted in
 * channel history — expiry governs how long the URL itself keeps working as a
 * data tap if it leaks out of Discord.
 */
export const CARD_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

function key(): string | null {
  // FAIL CLOSED, exactly as isAuthorizedDiscordService does. An unset secret
  // must not mean "sign with the empty string" — that would make every token
  // forgeable on precisely the deploy where nobody is looking.
  return process.env.DISCORD_SERVICE_SECRET || null;
}

const b64url = (b: Buffer) => b.toString('base64url');

function sign(payload: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(payload).digest());
}

/** Mint the token naming this player's card. Null when the secret is unset. */
export function mintCardToken(playerId: string, now = Date.now()): string | null {
  const secret = key();
  if (!secret) return null;

  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        p: playerId,
        e: Math.floor(now / 1000) + CARD_TOKEN_TTL_SECONDS,
      })
    )
  );
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * The player id this token names, or null if it does not name one.
 *
 * Every failure returns the same null: bad shape, bad signature, expired,
 * unset secret. The route turns that into one 404 with no body, so a prober
 * cannot learn which of those it hit — the same indistinguishability rule
 * 00165 applies to link tokens, for the same reason.
 */
export function readCardToken(token: string, now = Date.now()): string | null {
  const secret = key();
  if (!secret) return null;

  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const presented = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload, secret));

  // timingSafeEqual throws on a length mismatch. Compare same-width buffers and
  // AND in the length check so every path does the same work.
  const sameLength = presented.length === expected.length;
  if (!timingSafeEqual(sameLength ? presented : expected, expected) || !sameLength) {
    return null;
  }

  let claim: unknown;
  try {
    claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const { p, e } = (claim ?? {}) as { p?: unknown; e?: unknown };
  if (typeof p !== 'string' || typeof e !== 'number') return null;
  if (Math.floor(now / 1000) >= e) return null;

  return p;
}

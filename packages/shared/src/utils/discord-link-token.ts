import { DISCORD_LINK_TOKEN_REGEX } from './constants';

/**
 * Hash a Discord link token for storage and lookup.
 *
 * ONE definition, deliberately, because two callers have to agree exactly: the
 * minting route hashes before the insert, and the /link page hashes before
 * calling consume_discord_link_token. If those ever diverged every link would
 * fail with the migration's intentionally vague "expired or already used"
 * message — which tells a member nothing and tells the logs nothing either,
 * because from the database's point of view the token genuinely was not found.
 *
 * Web Crypto rather than node:crypto so the same function works unchanged in a
 * route handler, in middleware and in the browser. SHA-256 with no salt is
 * correct here and not an oversight: the input is 32 bytes of CSPRNG output, so
 * there is no dictionary to attack, and the hash exists to stop a leaked
 * database dump being replayed into a link — not to protect a low-entropy
 * secret.
 */
export async function hashDiscordLinkToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * True when `value` could be a link token at all.
 *
 * Every hop of the sign-in chain calls this before putting the value back in a
 * URL. It is a shape check, not an authorisation check — only the database can
 * say whether a well-formed token is live.
 */
export function isDiscordLinkToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && DISCORD_LINK_TOKEN_REGEX.test(value);
}

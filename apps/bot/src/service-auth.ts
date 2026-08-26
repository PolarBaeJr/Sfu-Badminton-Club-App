import { timingSafeEqual } from 'node:crypto';

/**
 * Bearer check for the bot's own machine-to-machine endpoints.
 *
 * The mirror image of the app's isAuthorizedDiscordService: same secret, same
 * fail-closed rule. Both sides had to have one, because the traffic goes both
 * ways — the bot calls the app for data, and whatever drives the reconciliation
 * sweep calls the bot.
 */
export function isAuthorizedService(authorization: string | undefined): boolean {
  const expected = process.env.DISCORD_SERVICE_SECRET;
  // No secret configured means nothing can be authorised. An unconfigured
  // deploy must not be an open one.
  if (!expected) return false;
  if (!authorization?.startsWith('Bearer ')) return false;

  const presented = Buffer.from(authorization.slice('Bearer '.length));
  const secret = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Compare something of the right size either way and fold the real
  // length check into the result.
  const sameLength = presented.length === secret.length;
  const a = sameLength ? presented : secret;
  return timingSafeEqual(a, secret) && sameLength;
}

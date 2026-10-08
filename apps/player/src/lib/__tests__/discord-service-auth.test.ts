import { afterEach, describe, expect, it } from 'vitest';
import { isAuthorizedDiscordService } from '../discord-service-auth';

const SECRET = 'correct-horse-battery-staple';

function req(authorization?: string) {
  return new Request('https://example.test/api/discord/sessions', {
    headers: authorization ? { authorization } : {},
  });
}

afterEach(() => {
  delete process.env.DISCORD_SERVICE_SECRET;
});

describe('isAuthorizedDiscordService', () => {
  it('accepts the correct bearer token', () => {
    process.env.DISCORD_SERVICE_SECRET = SECRET;
    expect(isAuthorizedDiscordService(req(`Bearer ${SECRET}`))).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    process.env.DISCORD_SERVICE_SECRET = SECRET;
    const wrong = 'x'.repeat(SECRET.length);
    expect(isAuthorizedDiscordService(req(`Bearer ${wrong}`))).toBe(false);
  });

  // timingSafeEqual throws on a length mismatch. If that ever reaches the
  // caller it becomes a 500 instead of a 401, which both leaks the length and
  // breaks the route.
  it('rejects tokens of the wrong length without throwing', () => {
    process.env.DISCORD_SERVICE_SECRET = SECRET;
    expect(() => isAuthorizedDiscordService(req('Bearer short'))).not.toThrow();
    expect(isAuthorizedDiscordService(req('Bearer short'))).toBe(false);
    expect(isAuthorizedDiscordService(req(`Bearer ${SECRET}extra`))).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    process.env.DISCORD_SERVICE_SECRET = SECRET;
    expect(isAuthorizedDiscordService(req())).toBe(false);
    expect(isAuthorizedDiscordService(req(SECRET))).toBe(false);
    expect(isAuthorizedDiscordService(req(`Basic ${SECRET}`))).toBe(false);
  });

  // THE IMPORTANT ONE. A deploy where the secret failed to land must refuse
  // everything, not admit everything — and it is exactly the deploy nobody is
  // watching.
  it('fails closed when the secret is not configured', () => {
    expect(isAuthorizedDiscordService(req('Bearer anything'))).toBe(false);
    expect(isAuthorizedDiscordService(req('Bearer '))).toBe(false);
    expect(isAuthorizedDiscordService(req())).toBe(false);
  });
});

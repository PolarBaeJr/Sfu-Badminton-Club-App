import { describe, it, expect, afterEach, vi } from 'vitest';

import { signPayload, verifyPayload } from '../passkey/cookie';

afterEach(() => {
  vi.useRealTimers();
});

describe('passkey cookie sign/verify', () => {
  it('round-trips a signed payload', async () => {
    const token = await signPayload({ sub: 'user-1', type: 'auth', challenge: 'abc' }, 60);
    const payload = await verifyPayload(token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('user-1');
    expect(payload!.type).toBe('auth');
    expect(payload!.challenge).toBe('abc');
  });

  it('rejects an expired token', async () => {
    const token = await signPayload({ sub: 'user-1' }, 60);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    expect(await verifyPayload(token)).toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const token = await signPayload({ sub: 'user-1' }, 60);
    const [body, sig] = token.split('.') as [string, string];
    const flipped = sig[0] === 'A' ? 'B' : 'A';
    expect(await verifyPayload(`${body}.${flipped}${sig.slice(1)}`)).toBeNull();
  });

  it('rejects a tampered body', async () => {
    const forSelf = await signPayload({ sub: 'attacker' }, 60);
    const forVictim = await signPayload({ sub: 'victim' }, 60);
    const [, sig] = forVictim.split('.') as [string, string];
    const [attackerBody] = forSelf.split('.') as [string, string];
    // Attacker body with victim signature must not verify.
    expect(await verifyPayload(`${attackerBody}.${sig}`)).toBeNull();
  });

  it('rejects malformed tokens', async () => {
    expect(await verifyPayload('')).toBeNull();
    expect(await verifyPayload('not-a-token')).toBeNull();
    expect(await verifyPayload('a.b.c')).toBeNull();
    expect(await verifyPayload('!!!.???')).toBeNull();
  });

  it('surfaces the sub so callers can reject a wrong user', async () => {
    // The sub check lives at the call sites (middleware, gates, handlers):
    // a valid token for another user still verifies, but its sub differs.
    const token = await signPayload({ sub: 'user-1' }, 60);
    const payload = await verifyPayload(token);
    expect(payload!.sub).not.toBe('user-2');
    expect(payload!.sub === 'user-1').toBe(true);
  });
});

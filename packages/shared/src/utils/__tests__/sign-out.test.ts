import { describe, it, expect } from 'vitest';
import { signOutEverywhere, signOutOtherDevices, signOutThisDevice } from '../sign-out';

function fakeAuth(error: unknown = null) {
  const scopes: string[] = [];
  return {
    scopes,
    signOut: async (options: { scope: 'local' | 'global' | 'others' }) => {
      scopes.push(options.scope);
      return { error };
    },
  };
}

// auth-js defaults to `global`, so a bare signOut() on one device ends every
// session everywhere. Each helper must name its own scope.
describe('sign-out scopes', () => {
  it('signs this device out locally', async () => {
    const auth = fakeAuth();
    expect(await signOutThisDevice(auth)).toEqual({ error: null });
    expect(auth.scopes).toEqual(['local']);
  });

  it('signs out everywhere globally', async () => {
    const auth = fakeAuth();
    expect(await signOutEverywhere(auth)).toEqual({ error: null });
    expect(auth.scopes).toEqual(['global']);
  });

  it('signs out every other device, and hands back a failed revoke', async () => {
    const auth = fakeAuth();
    await signOutOtherDevices(auth);
    expect(auth.scopes).toEqual(['others']);

    const failure = new Error('network');
    expect(await signOutOtherDevices(fakeAuth(failure))).toEqual({ error: failure });
  });
});

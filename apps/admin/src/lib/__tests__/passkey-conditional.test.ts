import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  attemptConditionalSignIn,
  beginConditionalPasskeySignIn,
  cancelPasskeyCeremony,
  PASSKEY_AUTOFILL_AUTOCOMPLETE,
  type ConditionalSignInSteps,
} from '../passkey-client';

// The console's half of conditional passkey sign-in. Same contract as the
// player app's (see apps/player/src/lib/__tests__/passkey-conditional.test.ts
// for the long-form reasoning): nobody asked for this request, so only success
// is allowed to reach the screen.
//
// Kept as a real second suite rather than a shared one because the two clients
// are separate modules by design — the console's talks to withBase()-prefixed
// routes — and a mirrored file is exactly where a divergence would hide.

function steps(overrides: Partial<ConditionalSignInSteps> = {}): ConditionalSignInSteps {
  return {
    autofillAvailable: async () => true,
    requestOptions: async () => ({ challenge: 'Y2hhbGxlbmdl' }) as never,
    authenticate: async () => ({ id: 'cred-1' }) as never,
    verifyCredential: async () => true,
    ...overrides,
  };
}

describe('admin conditional passkey sign-in', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  });

  it('is not attempted when the browser cannot do conditional mediation', async () => {
    const authenticate = vi.fn();
    const s = steps({ autofillAvailable: async () => false, authenticate });

    await expect(attemptConditionalSignIn(s)).resolves.toBe(false);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('resolves false on an abort rather than rejecting', async () => {
    const abort = Object.assign(new Error('Cancelling existing WebAuthn API call for new one'), {
      name: 'AbortError',
    });
    const s = steps({
      authenticate: async () => {
        throw abort;
      },
    });

    await expect(attemptConditionalSignIn(s)).resolves.toBe(false);
  });

  it('resolves false on the plain Error the library throws for a missing input', async () => {
    // name === 'Error', so the console's isUserCancellation() would classify
    // this as a genuine failure and print "No passkey was used." if this path
    // ever went through signInWithPasskey.
    const s = steps({
      authenticate: async () => {
        throw new Error('No <input> with "webauthn" ... was detected');
      },
    });

    await expect(attemptConditionalSignIn(s)).resolves.toBe(false);
  });

  it('reports true only when the server verified the assertion', async () => {
    await expect(attemptConditionalSignIn(steps())).resolves.toBe(true);
    await expect(
      attemptConditionalSignIn(steps({ verifyCredential: async () => false }))
    ).resolves.toBe(false);
  });

  it('makes no request where WebAuthn is absent', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(beginConditionalPasskeySignIn()).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('pins the autofill token order', () => {
    expect(PASSKEY_AUTOFILL_AUTOCOMPLETE.endsWith('webauthn')).toBe(true);
  });

  it('cancels safely with nothing in flight', () => {
    expect(() => cancelPasskeyCeremony()).not.toThrow();
  });
});

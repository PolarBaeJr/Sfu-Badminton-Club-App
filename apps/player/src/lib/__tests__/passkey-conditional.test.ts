import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  attemptConditionalSignIn,
  beginConditionalPasskeySignIn,
  cancelPasskeyCeremony,
  PASSKEY_AUTOFILL_AUTOCOMPLETE,
  type ConditionalSignInSteps,
} from '../passkey-client';

// Conditional (autofill) passkey sign-in is SPECULATIVE: nobody asked for it,
// so the only outcome allowed to reach the member is success. Everything below
// is an assertion about silence — that it is not attempted where it cannot
// work, that no rejection escapes, and that none of it can disturb the emailed
// code form it runs alongside.
//
// These run under vitest's `node` environment (there is no jsdom in this repo),
// which is why the ceremony is split into named steps: the sequencing — the
// part that actually decides whether anything is said — is testable without a
// DOM, and the two tests at the bottom then drive the REAL browser helpers to
// prove the production wiring behaves the same way.

type Recorder = ConditionalSignInSteps & {
  calls: { options: number; authenticate: number; verify: number };
};

// Every step succeeds unless a test overrides one, so each test states only the
// thing it is about.
function steps(overrides: Partial<ConditionalSignInSteps> = {}): Recorder {
  const calls = { options: 0, authenticate: 0, verify: 0 };
  const base: ConditionalSignInSteps = {
    autofillAvailable: async () => true,
    requestOptions: async () => {
      calls.options += 1;
      return { challenge: 'Y2hhbGxlbmdl' } as never;
    },
    authenticate: async () => {
      calls.authenticate += 1;
      return { id: 'cred-1' } as never;
    },
    verifyCredential: async () => {
      calls.verify += 1;
      return true;
    },
  };
  return Object.assign(base, overrides, { calls }) as Recorder;
}

describe('attemptConditionalSignIn — it is not attempted where it cannot work', () => {
  it('stops at the feature check, before any network call', async () => {
    const s = steps({ autofillAvailable: async () => false });

    await expect(attemptConditionalSignIn(s)).resolves.toBe(false);

    // The options route is rate-limited per IP and the whole club shares one
    // campus NAT. A browser that could never complete the ceremony must not
    // spend anyone's budget finding that out.
    expect(s.calls.options).toBe(0);
    expect(s.calls.authenticate).toBe(0);
  });

  it('treats a thrown feature check as unsupported, not as an error', async () => {
    const s = steps({
      autofillAvailable: async () => {
        throw new Error('isConditionalMediationAvailable exploded');
      },
    });

    await expect(attemptConditionalSignIn(s)).resolves.toBe(false);
    expect(s.calls.options).toBe(0);
  });

  it('gives up quietly when the options route refuses (429 / 503)', async () => {
    // A 429 here is the realistic one: /login now mints a challenge on every
    // view. It must degrade to "no offer", never to a message.
    const s = steps({ requestOptions: async () => null });

    await expect(attemptConditionalSignIn(s)).resolves.toBe(false);
    expect(s.calls.authenticate).toBe(0);
  });
});

describe('attemptConditionalSignIn — every failure is silent', () => {
  // The shapes this can actually reject with. The last two are the dangerous
  // ones: @simplewebauthn/browser throws them as PLAIN Errors (name === 'Error'),
  // so the existing isUserCancellation() check calls them real failures and the
  // button flow would surface "No passkey was used." — the exact toast a
  // speculative request must never produce.
  const rejections: [string, unknown][] = [
    ['an abort (the member pressed the passkey button instead)', Object.assign(new Error('Cancelling existing WebAuthn API call for new one'), { name: 'AbortError' })],
    ['a dismissed picker', Object.assign(new Error('The operation either timed out or was not allowed'), { name: 'NotAllowedError' })],
    ['no eligible <input>', new Error('No <input> with "webauthn" as the only or last value in its `autocomplete` attribute was detected')],
    ['autofill unsupported after all', new Error('Browser does not support WebAuthn autofill')],
    ['a non-Error rejection', 'something threw a string'],
  ];

  for (const [label, thrown] of rejections) {
    it(`resolves false — never rejects — on ${label}`, async () => {
      const s = steps({
        authenticate: async () => {
          throw thrown;
        },
      });

      // .resolves is the assertion: an unhandled rejection here would surface
      // in the page as an error toast or a console error on a request the
      // member never made.
      await expect(attemptConditionalSignIn(s)).resolves.toBe(false);
      expect(s.calls.verify).toBe(0);
    });
  }

  it('resolves false when the assertion is rejected by the server', async () => {
    const s = steps({ verifyCredential: async () => false });
    await expect(attemptConditionalSignIn(s)).resolves.toBe(false);
  });

  it('resolves false when verification itself throws', async () => {
    const s = steps({
      verifyCredential: async () => {
        throw new Error('network down');
      },
    });
    await expect(attemptConditionalSignIn(s)).resolves.toBe(false);
  });
});

describe('attemptConditionalSignIn — success', () => {
  it('reports true only after the server has verified the assertion', async () => {
    const s = steps();

    await expect(attemptConditionalSignIn(s)).resolves.toBe(true);

    expect(s.calls.options).toBe(1);
    expect(s.calls.authenticate).toBe(1);
    expect(s.calls.verify).toBe(1);
  });

  it('passes the server options straight through to the authenticator', async () => {
    const seen: unknown[] = [];
    const options = { challenge: 'Y2hhbGxlbmdl', rpId: 'sfubadminton.com' };
    const s = steps({
      requestOptions: async () => options as never,
      authenticate: async (o) => {
        seen.push(o);
        return { id: 'cred-1' } as never;
      },
    });

    await attemptConditionalSignIn(s);

    // The challenge must be the one the server just signed into the cookie —
    // anything reconstructed client-side would fail verification.
    expect(seen).toEqual([options]);
  });
});

describe('the autofill field contract', () => {
  it('ends with the webauthn token', () => {
    // Both the browser and @simplewebauthn/browser locate the field with
    // `input[autocomplete$='webauthn']`. Reordering these two words is a silent
    // way to switch the whole feature off, so it is pinned here.
    expect(PASSKEY_AUTOFILL_AUTOCOMPLETE.endsWith('webauthn')).toBe(true);
    expect(PASSKEY_AUTOFILL_AUTOCOMPLETE.split(/\s+/)).toContain('username');
  });
});

describe('the real browser wiring', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  });

  it('makes no request at all where WebAuthn is absent', async () => {
    // Node has no PublicKeyCredential, so this drives the genuine feature
    // detection — browserSupportsWebAuthnAutofill() — rather than a stub of it.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(beginConditionalPasskeySignIn()).resolves.toBe(false);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('swallows the real library error when the ceremony cannot start', async () => {
    // Claim conditional mediation is available, then let startAuthentication
    // hit the genuine "no eligible <input>" path (there is no document here).
    // This is the end-to-end proof that the production function — not just the
    // orchestrator — stays quiet.
    //
    // A class, not an object literal: browserSupportsWebAuthn() tests
    // `typeof globalThis.PublicKeyCredential === 'function'`, so a plain object
    // reads as "no WebAuthn" and the request would be skipped rather than
    // failing — which is a different test than the one intended here.
    class PublicKeyCredentialStub {
      static async isConditionalMediationAvailable() {
        return true;
      }
    }
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential =
      PublicKeyCredentialStub;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ challenge: 'Y2hhbGxlbmdl', rpId: 'localhost', allowCredentials: [] }),
    })) as unknown as typeof fetch;

    await expect(beginConditionalPasskeySignIn()).resolves.toBe(false);

    // It got as far as asking the server, so the silence above is the library
    // failing for real and being swallowed — not the feature check short-
    // circuiting before anything happened.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('cancelling when nothing is in flight is a no-op, not a throw', () => {
    // Called from the login page's effect cleanup, which runs on every mode
    // switch and unmount whether or not a ceremony was ever started.
    expect(() => cancelPasskeyCeremony()).not.toThrow();
    expect(() => cancelPasskeyCeremony()).not.toThrow();
  });
});

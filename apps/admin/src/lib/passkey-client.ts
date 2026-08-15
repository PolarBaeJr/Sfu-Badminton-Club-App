// Browser half of the passkey SIGN-IN flow (the one that starts logged out).
//
// The enrol and step-up flows call @simplewebauthn/browser directly from their
// own components — they are already inside a session and each has different
// surrounding state to manage. This is kept separate rather than folded in with
// them because it is the only one that talks to /api/passkey/login/*.
import {
  startAuthentication,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  WebAuthnAbortService,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { friendlyPasskeyError } from './passkey/errors';
import { withBase } from './base-path';

export type PasskeyResult = { ok: true } | { ok: false; error: string };

export function supportsPasskeys(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

// See the player app's copy for the full reasoning: the `webauthn` token must
// be LAST, and both the browser and @simplewebauthn/browser enforce that.
export const PASSKEY_AUTOFILL_AUTOCOMPLETE = 'username webauthn';

// One challenge cookie per app, so two overlapping ceremonies fight over it.
// Every path about to mint a fresh challenge cancels whatever is in flight.
export function cancelPasskeyCeremony(): void {
  try {
    WebAuthnAbortService.cancelCeremony();
  } catch {
    // Nothing in flight, or no AbortController in this environment.
  }
}

// A cancelled prompt is a normal thing to do, not an error worth shouting
// about — the browser reports it as NotAllowedError / AbortError. An empty
// message tells the caller to say nothing at all.
function isUserCancellation(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

async function errorFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return typeof body?.error === 'string' ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export async function signInWithPasskey(): Promise<PasskeyResult> {
  if (!supportsPasskeys()) {
    return { ok: false, error: 'This device does not support passkeys.' };
  }

  // Cancel the speculative autofill request before minting a new challenge —
  // the fetch below would otherwise replace the cookie it is waiting on.
  cancelPasskeyCeremony();

  const optionsRes = await fetch(withBase('/api/passkey/login/options'), { method: 'POST' });
  if (!optionsRes.ok) {
    return { ok: false, error: await errorFrom(optionsRes, 'Could not start passkey sign-in.') };
  }

  let credential;
  try {
    credential = await startAuthentication({ optionsJSON: await optionsRes.json() });
  } catch (err) {
    if (isUserCancellation(err)) return { ok: false, error: '' };
    return { ok: false, error: friendlyPasskeyError(err, 'No passkey was used.') };
  }

  const verifyRes = await fetch(withBase('/api/passkey/login/verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  if (!verifyRes.ok) {
    return { ok: false, error: await errorFrom(verifyRes, 'Passkey sign-in failed.') };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Conditional mediation ("passkey autofill")
// ---------------------------------------------------------------------------
//
// Mirrors the player app deliberately — see apps/player/src/lib/passkey-client
// for the long-form reasoning. It is worth having here even though the console
// has few users: those users are the ones migration 00050 refuses to let drop
// their last passkey, so every one of them HAS a credential and the offer
// essentially always fires. This is also the console's own step-up path's
// nearest neighbour, and keeping the two apps' sign-in behaviour identical is
// what stops one of them drifting into a bespoke, less-tested flow.
//
// It cannot interfere with the console's step-up gate: that lives on
// /unavailable and talks to /api/passkey/auth/*, a different route pair with a
// different challenge type, and it has no email field for autofill to attach to.
//
// Speculative, therefore silent. The two failures unique to this path throw
// plain Errors whose `name` is "Error", so isUserCancellation() would call them
// real and surface "No passkey was used." — hence a separate function rather
// than a flag threaded through signInWithPasskey.

export type ConditionalSignInSteps = {
  autofillAvailable: () => Promise<boolean>;
  requestOptions: () => Promise<PublicKeyCredentialRequestOptionsJSON | null>;
  authenticate: (
    optionsJSON: PublicKeyCredentialRequestOptionsJSON
  ) => Promise<AuthenticationResponseJSON>;
  verifyCredential: (credential: AuthenticationResponseJSON) => Promise<boolean>;
};

/** True only when a session now exists. Every other outcome is a silent false. */
export async function attemptConditionalSignIn(
  steps: ConditionalSignInSteps
): Promise<boolean> {
  try {
    if (!(await steps.autofillAvailable())) return false;
    const optionsJSON = await steps.requestOptions();
    if (!optionsJSON) return false;
    const credential = await steps.authenticate(optionsJSON);
    return await steps.verifyCredential(credential);
  } catch {
    return false;
  }
}

const browserConditionalSteps: ConditionalSignInSteps = {
  autofillAvailable: () => browserSupportsWebAuthnAutofill(),
  requestOptions: async () => {
    const res = await fetch(withBase('/api/passkey/login/options'), { method: 'POST' });
    return res.ok ? ((await res.json()) as PublicKeyCredentialRequestOptionsJSON) : null;
  },
  authenticate: (optionsJSON) => startAuthentication({ optionsJSON, useBrowserAutofill: true }),
  verifyCredential: async (credential) => {
    const res = await fetch(withBase('/api/passkey/login/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    return res.ok;
  },
};

export function beginConditionalPasskeySignIn(): Promise<boolean> {
  return attemptConditionalSignIn(browserConditionalSteps);
}

// Browser half of the passkey flows. Kept in one place because enrolment is
// offered from four different surfaces (login, onboarding, settings, and the
// nudge banner) and they must all behave identically.
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  WebAuthnAbortService,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

export type PasskeyResult = { ok: true } | { ok: false; error: string };

export function supportsPasskeys(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/**
 * The `autocomplete` value the sign-in email field MUST carry for conditional
 * UI to run at all.
 *
 * WebAuthn autofill is opt-in per FIELD, not per page: the browser only offers
 * a passkey in the dropdown of an input whose `autocomplete` list ENDS with
 * `webauthn`, and @simplewebauthn/browser enforces the same rule client-side
 * with the selector `input[autocomplete$='webauthn']` before it will call
 * navigator.credentials.get(). Get the order wrong ("webauthn username") and
 * the whole feature is a silent no-op that looks implemented.
 *
 * Exported as a constant, and asserted in the tests, so the token order cannot
 * be reversed by a well-meaning edit without something going red.
 */
export const PASSKEY_AUTOFILL_AUTOCOMPLETE = 'username webauthn';

/**
 * Abort whatever WebAuthn ceremony is currently in flight.
 *
 * There is exactly ONE challenge cookie per app (player_passkey_challenge), so
 * two overlapping ceremonies are not merely wasteful — the second one's
 * /login/options call overwrites the first one's challenge, and if the first
 * then completes, verification compares the assertion against the wrong
 * challenge and fails for no reason the member can see. Every path that is
 * about to mint a fresh challenge cancels first.
 */
export function cancelPasskeyCeremony(): void {
  try {
    WebAuthnAbortService.cancelCeremony();
  } catch {
    // Nothing in flight, or no AbortController in this environment.
  }
}

// A cancelled prompt is a normal thing to do, not an error worth shouting
// about — the browser reports it as NotAllowedError / AbortError.
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

export async function enrollPasskey(nickname?: string): Promise<PasskeyResult> {
  if (!supportsPasskeys()) {
    return { ok: false, error: 'This device does not support passkeys.' };
  }

  const optionsRes = await fetch('/api/passkey/register/options', { method: 'POST' });
  if (!optionsRes.ok) {
    return { ok: false, error: await errorFrom(optionsRes, 'Could not start passkey setup.') };
  }

  let credential;
  try {
    credential = await startRegistration({ optionsJSON: await optionsRes.json() });
  } catch (err) {
    if (isUserCancellation(err)) return { ok: false, error: '' };
    return { ok: false, error: 'Your device did not complete passkey setup.' };
  }

  const verifyRes = await fetch('/api/passkey/register/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential, nickname }),
  });
  if (!verifyRes.ok) {
    return { ok: false, error: await errorFrom(verifyRes, 'Could not save that passkey.') };
  }
  return { ok: true };
}

export async function signInWithPasskey(): Promise<PasskeyResult> {
  if (!supportsPasskeys()) {
    return { ok: false, error: 'This device does not support passkeys.' };
  }

  // The speculative conditional request (below) may still be waiting in the
  // email field's autofill. Kill it BEFORE minting a new challenge, or the
  // fetch on the next line replaces the cookie out from under it.
  cancelPasskeyCeremony();

  const optionsRes = await fetch('/api/passkey/login/options', { method: 'POST' });
  if (!optionsRes.ok) {
    return { ok: false, error: await errorFrom(optionsRes, 'Could not start passkey sign-in.') };
  }

  let credential;
  try {
    credential = await startAuthentication({ optionsJSON: await optionsRes.json() });
  } catch (err) {
    if (isUserCancellation(err)) return { ok: false, error: '' };
    return { ok: false, error: 'No passkey was used.' };
  }

  const verifyRes = await fetch('/api/passkey/login/verify', {
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
// The button above requires the member to know that a passkey is the fast way
// in. Conditional mediation does not: the browser lists their passkey inside
// the email field's own autofill dropdown, they pick it, and they are in. No
// modal, no button, and — critically — NOTHING AT ALL happens when they have no
// credential for this site. That is what makes it safe to start unprompted, and
// it is why this must never be a plain navigator.credentials.get() on load: an
// unrequested system dialog that the member cancels is worse than the button.
//
// Everything here is SPECULATIVE. The member did not ask for it, so no outcome
// but success is allowed to produce a word of UI. That cannot be expressed by
// reusing signInWithPasskey's error shape, because the two failures unique to
// this path — "Browser does not support WebAuthn autofill" and "No <input> with
// 'webauthn'…" — are plain Errors whose `name` is "Error". isUserCancellation()
// answers false for both, so they would surface as "No passkey was used.",
// exactly the toast that must not appear.

/**
 * The four browser-facing steps of a conditional sign-in, named so the
 * orchestration below can be exercised without a DOM.
 *
 * Both apps' test suites run under vitest's `node` environment and there is no
 * jsdom in this repo, so a component test is not available to prove "an abort
 * is silent". Splitting the sequencing from the browser calls makes the part
 * that actually decides silence testable for real.
 */
export type ConditionalSignInSteps = {
  autofillAvailable: () => Promise<boolean>;
  requestOptions: () => Promise<PublicKeyCredentialRequestOptionsJSON | null>;
  authenticate: (
    optionsJSON: PublicKeyCredentialRequestOptionsJSON
  ) => Promise<AuthenticationResponseJSON>;
  verifyCredential: (credential: AuthenticationResponseJSON) => Promise<boolean>;
};

/**
 * Runs the conditional ceremony and reports ONLY whether a session now exists.
 *
 * Returns false — never throws, never yields a message — for every other
 * outcome: unsupported browser, a 429 or 503 from the options route, the member
 * ignoring the dropdown and typing their email instead, the request being
 * aborted because they pressed the passkey button, or a rejected assertion.
 */
export async function attemptConditionalSignIn(
  steps: ConditionalSignInSteps
): Promise<boolean> {
  try {
    // Asked first, so an unsupported browser costs zero network. It also keeps
    // the options route — rate-limited per IP, and a whole club shares one NAT
    // on session night — from being hit by browsers that could never use it.
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
  // Wraps PublicKeyCredential.isConditionalMediationAvailable() and answers
  // false — rather than throwing — when PublicKeyCredential itself is absent,
  // so this single call is the whole feature detection.
  autofillAvailable: () => browserSupportsWebAuthnAutofill(),

  requestOptions: async () => {
    const res = await fetch('/api/passkey/login/options', { method: 'POST' });
    return res.ok ? ((await res.json()) as PublicKeyCredentialRequestOptionsJSON) : null;
  },

  // useBrowserAutofill sets mediation: 'conditional' and empties
  // allowCredentials. The options route already returns no allowCredentials by
  // design (it must not answer "does this address have an account"), so the
  // discoverable-credential requirement conditional UI has is already met.
  authenticate: (optionsJSON) => startAuthentication({ optionsJSON, useBrowserAutofill: true }),

  verifyCredential: async (credential) => {
    const res = await fetch('/api/passkey/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    return res.ok;
  },
};

/**
 * Offer the member's passkey in the email field's autofill, if their browser
 * can do that. Resolves true only when a session was actually created.
 */
export function beginConditionalPasskeySignIn(): Promise<boolean> {
  return attemptConditionalSignIn(browserConditionalSteps);
}

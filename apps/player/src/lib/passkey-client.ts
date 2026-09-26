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
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import * as Sentry from '@sentry/nextjs';

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

// ---------------------------------------------------------------------------
// Options prefetch
// ---------------------------------------------------------------------------
//
// iOS Safari only opens the passkey sheet when navigator.credentials.get() or
// create() is called inside the member's tap (transient user activation). An
// `await fetch(options)` between the tap and the call spends that activation,
// Safari refuses with NotAllowedError, and since that is also what a cancelled
// prompt looks like, the tap silently did nothing. So the options are fetched
// BEFORE the tap and the ceremony starts synchronously from it:
// @simplewebauthn/browser awaits nothing before credentials.get/create on the
// modal path.
//
// The server challenge (and its cookie) lives CHALLENGE_TTL_SECONDS, 5 minutes;
// cached options are only used for 4 so a slow tap never presents a challenge
// the server has already expired.
export const OPTIONS_FRESH_MS = 4 * 60 * 1000;

export type OptionsCache<T> = {
  /** Fetch unless a fresh result or an in-flight fetch exists; share that instead. */
  prime: () => Promise<T | null>;
  /** Synchronous: the resolved options if still fresh, otherwise null. */
  takeFresh: () => T | null;
  /** Forget the options, because the challenge behind them is spent or replaced. */
  invalidate: () => void;
};

/**
 * One cache per purpose. prime() dedupes, because there is ONE challenge cookie
 * per app and the last options fetch wins: a StrictMode double effect or two
 * components priming at once must not mint two challenges and strand the first.
 */
export function createOptionsCache<T>(
  fetcher: () => Promise<T | null>,
  now: () => number = Date.now
): OptionsCache<T> {
  let promise: Promise<T | null> | null = null;
  let options: T | null = null;
  let fetchedAt = 0;
  // Bumped by every new fetch and every invalidate, so a fetch that settles
  // after being superseded cannot write its stale result back.
  let generation = 0;

  const isFresh = () => options !== null && now() - fetchedAt < OPTIONS_FRESH_MS;

  return {
    prime() {
      if (promise && (options === null || isFresh())) return promise;
      options = null;
      const mine = ++generation;
      const pending: Promise<T | null> = fetcher()
        .catch(() => null)
        .then((result) => {
          if (mine !== generation) return result;
          if (result === null) {
            promise = null;
            return null;
          }
          options = result;
          fetchedAt = now();
          return result;
        });
      promise = pending;
      return pending;
    },
    takeFresh() {
      return isFresh() ? options : null;
    },
    invalidate() {
      generation += 1;
      promise = null;
      options = null;
    },
  };
}

type OptionsPurpose = 'login' | 'register';

// The options route's own error text ("Too many attempts", "not configured"),
// kept so the fetch-then-start fallback can still show it.
const lastOptionsError: Record<OptionsPurpose, string | null> = { login: null, register: null };

function optionsFetcher<T>(purpose: OptionsPurpose, fallback: string): () => Promise<T | null> {
  return async () => {
    // Both purposes share the one challenge cookie, so fetching either spends
    // whatever the other one had cached.
    optionsCaches[purpose === 'login' ? 'register' : 'login'].invalidate();
    lastOptionsError[purpose] = null;
    const res = await fetch(`/api/passkey/${purpose}/options`, { method: 'POST' });
    if (!res.ok) {
      lastOptionsError[purpose] = await errorFrom(res, fallback);
      return null;
    }
    return (await res.json()) as T;
  };
}

const optionsCaches = {
  login: createOptionsCache<PublicKeyCredentialRequestOptionsJSON>(
    optionsFetcher('login', 'Could not start passkey sign-in.')
  ),
  register: createOptionsCache<PublicKeyCredentialCreationOptionsJSON>(
    optionsFetcher('register', 'Could not start passkey setup.')
  ),
};

/** Fetch sign-in options ahead of the tap, so the button can start synchronously. */
export function primePasskeySignIn(): void {
  if (!supportsPasskeys()) return;
  void optionsCaches.login.prime();
}

/** Fetch enrolment options ahead of the tap, so the button can start synchronously. */
export function primePasskeyEnrollment(): void {
  if (!supportsPasskeys()) return;
  void optionsCaches.register.prime();
}

/**
 * Calls `callback` whenever the page comes back: the tab becomes visible again
 * or the window regains focus. Returns the cleanup. Paired with prime(), which
 * fetches only when the cached options are stale or missing, so a return inside
 * the fresh window costs nothing, and a member who left the page open longer
 * than that still gets a first tap that works on iOS.
 */
export function onPageReturn(
  callback: () => void,
  win: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window,
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> = document
): () => void {
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') callback();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('focus', callback);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('focus', callback);
  };
}

/** Keep the sign-in options fresh while the page is left open. Returns the cleanup. */
export function keepPasskeySignInFresh(): () => void {
  return onPageReturn(primePasskeySignIn);
}

/** Keep the enrolment options fresh while the page is left open. Returns the cleanup. */
export function keepPasskeyEnrollmentFresh(): () => void {
  return onPageReturn(primePasskeyEnrollment);
}

/**
 * Drop any cached enrolment options and fetch new ones. For after a passkey is
 * removed: the cached excludeCredentials still lists it, so re-adding it on the
 * same device would be refused by the authenticator.
 */
export function refreshPasskeyEnrollment(): void {
  optionsCaches.register.invalidate();
  primePasskeyEnrollment();
}

// Why a tap produced no passkey, sent without any user identifier. The member
// sees nothing for a cancellation, so without this an iOS refusal and a genuine
// "changed my mind" are indistinguishable. `prefetched` says which path ran.
function reportCeremonyError(flow: 'signin' | 'enrol', err: unknown, prefetched: boolean): void {
  try {
    const e = err as { name?: string; message?: string } | null;
    // The global scope carries the player id once signed in (enrol runs signed
    // in); this diagnostic is sent without it.
    Sentry.withScope((scope) => {
      scope.setUser(null);
      Sentry.captureMessage(`passkey ${flow} ceremony did not complete`, {
        level: isUserCancellation(err) ? 'info' : 'warning',
        tags: { passkey: flow, passkey_error: e?.name ?? 'unknown' },
        extra: { message: e?.message ?? String(err), prefetched },
      });
    });
  } catch {
    // Reporting must never break the flow.
  }
}

export async function enrollPasskey(nickname?: string): Promise<PasskeyResult> {
  if (!supportsPasskeys()) {
    return { ok: false, error: 'This device does not support passkeys.' };
  }

  // Nothing may be awaited before startRegistration on the prefetched path (see
  // "Options prefetch"). Without a prefetch this falls back to fetch-then-start,
  // which still works everywhere except iOS; the fetch leaves the options cached,
  // so a second tap there does work.
  const cached = optionsCaches.register.takeFresh();
  let credential;
  try {
    if (cached) {
      credential = await startRegistration({ optionsJSON: cached });
    } else {
      const optionsJSON = await optionsCaches.register.prime();
      if (!optionsJSON) {
        return {
          ok: false,
          error: lastOptionsError.register ?? 'Could not start passkey setup.',
        };
      }
      credential = await startRegistration({ optionsJSON });
    }
  } catch (err) {
    reportCeremonyError('enrol', err, cached !== null);
    if (isUserCancellation(err)) return { ok: false, error: '' };
    return { ok: false, error: 'Your device did not complete passkey setup.' };
  }

  // The server consumes the challenge on verify whatever the outcome, and a
  // successful enrol changes excludeCredentials anyway.
  optionsCaches.register.invalidate();
  const verifyRes = await fetch('/api/passkey/register/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential, nickname }),
  });
  if (!verifyRes.ok) {
    // That challenge is spent. Fetch the next now, so a retry starts from the tap.
    primePasskeyEnrollment();
    return { ok: false, error: await errorFrom(verifyRes, 'Could not save that passkey.') };
  }
  return { ok: true };
}

export async function signInWithPasskey(): Promise<PasskeyResult> {
  if (!supportsPasskeys()) {
    return { ok: false, error: 'This device does not support passkeys.' };
  }

  // The speculative conditional request (below) may still be waiting in the
  // email field's autofill. Abort it first: the button then reuses the SAME
  // challenge, which is still unspent because nothing has been verified yet.
  cancelPasskeyCeremony();

  // Nothing may be awaited before startAuthentication on the prefetched path
  // (see "Options prefetch"). The fallback fetch-then-start still works
  // everywhere except iOS, and leaves the options cached for a second tap.
  const cached = optionsCaches.login.takeFresh();
  let credential;
  try {
    if (cached) {
      credential = await startAuthentication({ optionsJSON: cached });
    } else {
      const optionsJSON = await optionsCaches.login.prime();
      if (!optionsJSON) {
        return {
          ok: false,
          error: lastOptionsError.login ?? 'Could not start passkey sign-in.',
        };
      }
      credential = await startAuthentication({ optionsJSON });
    }
  } catch (err) {
    reportCeremonyError('signin', err, cached !== null);
    if (isUserCancellation(err)) return { ok: false, error: '' };
    return { ok: false, error: 'No passkey was used.' };
  }

  // Verify consumes the challenge whether or not it succeeds.
  optionsCaches.login.invalidate();
  const verifyRes = await fetch('/api/passkey/login/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  if (!verifyRes.ok) {
    // That challenge is spent. Fetch the next now, so a retry starts from the tap.
    // Not on success: the page redirects.
    primePasskeySignIn();
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

  // Shared with the button through the cache, so autofill and the button use
  // one challenge rather than overwriting each other's cookie.
  requestOptions: () => optionsCaches.login.prime(),

  // useBrowserAutofill sets mediation: 'conditional' and empties
  // allowCredentials. The options route already returns no allowCredentials by
  // design (it must not answer "does this address have an account"), so the
  // discoverable-credential requirement conditional UI has is already met.
  authenticate: (optionsJSON) => startAuthentication({ optionsJSON, useBrowserAutofill: true }),

  verifyCredential: async (credential) => {
    optionsCaches.login.invalidate();
    const res = await fetch('/api/passkey/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    if (!res.ok) primePasskeySignIn();
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

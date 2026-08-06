// Browser half of the passkey SIGN-IN flow (the one that starts logged out).
//
// The enrol and step-up flows call @simplewebauthn/browser directly from their
// own components — they are already inside a session and each has different
// surrounding state to manage. This is kept separate rather than folded in with
// them because it is the only one that talks to /api/passkey/login/*.
import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
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

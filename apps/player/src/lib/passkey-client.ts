// Browser half of the passkey flows. Kept in one place because enrolment is
// offered from four different surfaces (login, onboarding, settings, and the
// nudge banner) and they must all behave identically.
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from '@simplewebauthn/browser';

export type PasskeyResult = { ok: true } | { ok: false; error: string };

export function supportsPasskeys(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
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

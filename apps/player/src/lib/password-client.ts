'use client';

import { createClient } from '@/lib/supabase-browser';
import {
  authErrorCode,
  friendlyAuthError,
  isReauthNeededError,
  isSamePasswordError,
  shouldRetryOtpSend,
  withErrorCode,
} from '@badminton/shared';
// Aliased: shared's authErrorCode is the AUTH-xxx banner code, this one is
// GoTrue's raw code for Sentry.
import { reportAuthFailure, authErrorCode as gotrueErrorCode } from '@/lib/auth-telemetry';
import type { SendCodeError } from '@/lib/email-code-client';

// Email + password, the third way in beside the email code and the passkey.
// The password itself is only ever handed to supabase-js: never to telemetry,
// a URL or storage. Every report below carries GoTrue's error, not the input.

export async function signInWithEmailPassword(
  email: string,
  password: string,
): Promise<{ ok: true } | ({ ok: false } & SendCodeError)> {
  const supabase = createClient();
  const attempt = () => supabase.auth.signInWithPassword({ email, password });
  // The same single silent retry as sendEmailCode, for the same idle-gateway
  // 503. A wrong password is a 400 with a message, so it is never retried.
  let { error } = await attempt();
  if (error && shouldRetryOtpSend(error)) {
    await new Promise((r) => setTimeout(r, 900));
    ({ error } = await attempt());
  }
  if (!error) return { ok: true };
  reportAuthFailure({
    flow: 'password_signin',
    stage: 'verify',
    error: gotrueErrorCode(error),
    message: error.message,
  });
  return { ok: false, message: error.message, code: error.code, status: error.status };
}

/**
 * Set or change the signed-in member's password. `nonce` is the emailed
 * confirmation code, needed when GoTrue asks for reauthentication.
 */
export async function setMemberPassword(
  password: string,
  nonce?: string,
): Promise<{ ok: true } | ({ ok: false; needsReauth: boolean } & SendCodeError)> {
  const supabase = createClient();
  const { error } = await supabase.auth.updateUser({ password, ...(nonce ? { nonce } : {}) });
  if (!error || isSamePasswordError(error)) return { ok: true };
  const needsReauth = isReauthNeededError(error);
  reportAuthFailure({
    flow: 'password_set',
    stage: 'update',
    error: gotrueErrorCode(error),
    message: error.message,
    extra: { with_nonce: Boolean(nonce) },
  });
  return { ok: false, needsReauth, message: error.message, code: error.code, status: error.status };
}

/** Email the signed-in member a confirmation code for a password change. */
export async function sendReauthCode(): Promise<{ error: SendCodeError | null }> {
  const supabase = createClient();
  const { error } = await supabase.auth.reauthenticate();
  if (!error) return { error: null };
  reportAuthFailure({
    flow: 'password_reauth',
    stage: 'send',
    error: gotrueErrorCode(error),
    message: error.message,
  });
  return { error: { message: error.message, code: error.code, status: error.status } };
}

/**
 * The banner for a password that could not be saved. A refusal GoTrue did not
 * explain is AUTH-214 rather than the catch-all AUTH-000.
 */
export function passwordSaveMessage(res: SendCodeError & { needsReauth: boolean }): string {
  if (res.needsReauth) {
    return withErrorCode('Saving a password needs a confirmation code we email you.', 'AUTH-213');
  }
  const code = authErrorCode(res);
  return withErrorCode(friendlyAuthError(res.message), code === 'AUTH-000' ? 'AUTH-214' : code);
}

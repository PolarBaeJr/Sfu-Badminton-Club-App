'use client';

import { createClient } from '@/lib/supabase-browser';
import { shouldRetryOtpSend, shouldTryNextOtpType } from '@badminton/shared';
import { authSuffix } from '@/lib/auth-intent';

type OtpType = 'recovery' | 'signup';
export type SendCodeError = { message: string; code?: string; status?: number };

/**
 * Email a 6-digit code. `createUser: false` is the sign-in page's guard: left
 * to its default, signInWithOtp mints an account for whatever address is
 * typed, which is how a "sign in" used to create accounts. GoTrue refuses an
 * unknown address instead, and isUnknownAccountError recognises the refusal.
 */
export async function sendEmailCode(
  email: string,
  opts: { createUser: boolean }
): Promise<{ error: SendCodeError | null }> {
  const supabase = createClient();
  const send = () =>
    supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: opts.createUser,
        emailRedirectTo: `${window.location.origin}/auth/callback${authSuffix(window.location.search)}`,
      },
    });
  // The auth gateway can 503 on the first request after an idle period; a
  // single silent retry makes that invisible. Only that: a rate limit or an
  // unknown account would just be refused again, and cost another send.
  let { error } = await send();
  if (error && shouldRetryOtpSend(error)) {
    await new Promise((r) => setTimeout(r, 900));
    ({ error } = await send());
  }
  if (!error) return { error: null };
  return { error: { message: error.message, code: error.code, status: error.status } };
}

/**
 * Verify the 6-digit code. Codes (unlike links) survive corporate email
 * link-scanners (e.g. SFU/Microsoft Safe Links) that would otherwise pre-fetch
 * and consume a one-time magic link before the member clicks.
 *
 * GoTrue issues a different token type per flow, and the client cannot be
 * certain which one a person is in, so `order` is tried in turn. A wrong-type
 * attempt returns "not found" without consuming the real token.
 */
export async function verifyEmailCode(
  email: string,
  token: string,
  order: readonly OtpType[]
): Promise<{ ok: true } | { ok: false; message: string }> {
  const supabase = createClient();
  let message = '';
  for (const type of order) {
    const { error } = await supabase.auth.verifyOtp({ email, token, type });
    if (!error) return { ok: true };
    message = error.message ?? '';
    if (!shouldTryNextOtpType(message)) break;
  }
  return { ok: false, message: message || 'That code did not work. Request a new one.' };
}

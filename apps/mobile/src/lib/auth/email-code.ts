// Email sign-in by 6-digit code. Mirrors apps/player/src/lib/email-code-client.ts
// minus the parts that only exist on the web (the redirect URL, which a code
// never needs, and the Sentry telemetry, which this app does not ship).
import {
  SIGNIN_OTP_TYPES,
  isUnknownAccountError,
  shouldRetryOtpSend,
  shouldTryNextOtpType,
} from '@badminton/shared/src/utils/auth-otp';
import { authErrorCode, friendlyAuthError, withErrorCode } from '@badminton/shared/src/utils/auth-errors';
import type { MobileClient } from '../supabase/client';

export type SendCodeResult = { ok: true } | { ok: false; unknownAccount: boolean; message: string };

/**
 * Email a code to an EXISTING account. shouldCreateUser: false is the guard:
 * left to its default, signInWithOtp mints an account for whatever address is
 * typed. Accounts are created on the website, where the waivers are.
 */
export async function sendEmailCode(supabase: MobileClient, email: string): Promise<SendCodeResult> {
  const send = () => supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  // The auth gateway can 503 on the first request after an idle period; one
  // silent retry makes that invisible. Only that: a rate limit or an unknown
  // account would just be refused again, and cost another send.
  let { error } = await send();
  if (error && shouldRetryOtpSend(error)) {
    await new Promise((r) => setTimeout(r, 900));
    ({ error } = await send());
  }
  if (!error) return { ok: true };
  if (isUnknownAccountError(error)) return { ok: false, unknownAccount: true, message: '' };
  return {
    ok: false,
    unknownAccount: false,
    message: withErrorCode(friendlyAuthError(error.message), authErrorCode(error)),
  };
}

export type VerifyCodeResult =
  | { ok: true }
  | { ok: false; unfinished: true }
  | { ok: false; unfinished: false; message: string };

/**
 * Verify the code, trying each token type GoTrue might have issued in turn (see
 * SIGNIN_OTP_TYPES for why; a wrong-type attempt does not consume the token).
 *
 * Then the same check the web login makes: an auth user with no player row
 * never finished signing up. players_self is scoped to auth.uid(), so no row
 * and no error means exactly that, and the session is dropped on this device
 * only. A read error fails OPEN, as it does on the web.
 */
export async function verifyEmailCode(
  supabase: MobileClient,
  email: string,
  token: string,
): Promise<VerifyCodeResult> {
  let message = '';
  let code: string | undefined;
  let status: number | undefined;
  let verified = false;
  for (const type of SIGNIN_OTP_TYPES) {
    const { error } = await supabase.auth.verifyOtp({ email, token, type });
    if (!error) {
      verified = true;
      break;
    }
    message = error.message ?? '';
    code = error.code;
    status = error.status;
    if (!shouldTryNextOtpType(message)) break;
  }
  if (!verified) {
    return {
      ok: false,
      unfinished: false,
      message: withErrorCode(
        friendlyAuthError(message || 'That code did not work. Request a new one.'),
        authErrorCode({ message, code, status }),
      ),
    };
  }

  const { data, error: readError } = await supabase.from('players_self').select('id').maybeSingle();
  if (!readError && !data) {
    await supabase.auth.signOut({ scope: 'local' });
    return { ok: false, unfinished: true };
  }
  return { ok: true };
}

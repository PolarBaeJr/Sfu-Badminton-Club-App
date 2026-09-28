/**
 * Email + password sign-in, shared by every screen that sets a password.
 *
 * PASSWORD_MIN_LENGTH must equal GoTrue's GOTRUE_PASSWORD_MIN_LENGTH, which
 * the owner sets per host. Checking here first only saves a round trip; the
 * server is what enforces it.
 *
 * No composition rules (NIST 800-63B): length is what makes a password hard
 * to guess, and a breach-list check belongs on the server.
 */
export const PASSWORD_MIN_LENGTH = 10;

/** bcrypt's limit. GoTrue refuses anything longer. */
export const PASSWORD_MAX_LENGTH = 72;

/**
 * Why a password would be refused, or null when it is fine. The maximum is in
 * bytes, the way bcrypt measures it, so 72 accented characters do not pass
 * here and then fail on the server.
 */
export function passwordProblem(password: string): string | null {
  if (!password.trim()) return 'Choose a password.';
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_LENGTH) {
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  return null;
}

type AuthErrorLike = { message?: string | null; code?: string | null } | null | undefined;

/**
 * GoTrue refuses to "change" a password to the one already set. For the
 * member that is a success: the password they typed is the one that works.
 */
export function isSamePasswordError(err: AuthErrorLike): boolean {
  if (!err) return false;
  if (err.code === 'same_password') return true;
  return /should be different from the old password/i.test(err.message ?? '');
}

/**
 * GoTrue wants the emailed confirmation code (a reauthentication nonce)
 * before it changes the password on a session older than its window.
 */
export function isReauthNeededError(err: AuthErrorLike): boolean {
  if (!err) return false;
  if (err.code === 'reauthentication_needed') return true;
  return /requires reauthentication/i.test(err.message ?? '');
}

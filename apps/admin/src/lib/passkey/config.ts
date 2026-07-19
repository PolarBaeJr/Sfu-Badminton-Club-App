// Passkey (WebAuthn) gate configuration. Shared by the Edge middleware, the
// /api/passkey route handlers, and the server-action belt-and-braces check —
// so keep this file free of Node-only imports.

const DEFAULT_ADMIN_URL = 'http://localhost:3001';

export const PASSKEY_VERIFIED_COOKIE = 'admin_passkey_verified';
export const PASSKEY_CHALLENGE_COOKIE = 'admin_passkey_challenge';

export const VERIFIED_TTL_SECONDS = 12 * 60 * 60; // 12h
export const CHALLENGE_TTL_SECONDS = 5 * 60; // 5min

// The app is served under Next's basePath, so scope the cookies there.
export const PASSKEY_COOKIE_PATH = '/admin';

function adminUrl(): URL {
  return new URL(process.env.NEXT_PUBLIC_ADMIN_URL || DEFAULT_ADMIN_URL);
}

export function getRpId(): string {
  return adminUrl().hostname;
}

export function getExpectedOrigin(): string {
  return adminUrl().origin;
}

export function getCookieSecret(): string {
  const secret = process.env.ADMIN_PASSKEY_COOKIE_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ADMIN_PASSKEY_COOKIE_SECRET must be set in production');
  }
  // Deterministic dev fallback so local sessions survive restarts.
  return 'admin-passkey-dev-secret-do-not-use-in-production';
}

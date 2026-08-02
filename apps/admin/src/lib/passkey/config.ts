// Passkey (WebAuthn) gate configuration. Shared by the Edge middleware, the
// /api/passkey route handlers, and the server-action belt-and-braces check —
// so keep this file free of Node-only imports.

const DEFAULT_ADMIN_URL = 'http://localhost:3001';

export const PASSKEY_VERIFIED_COOKIE = 'admin_passkey_verified';
export const PASSKEY_CHALLENGE_COOKIE = 'admin_passkey_challenge';

export const VERIFIED_TTL_SECONDS = 12 * 60 * 60; // 12h
export const CHALLENGE_TTL_SECONDS = 5 * 60; // 5min

// Served from the root of its own subdomain now, so the cookie scopes to '/'.
// (It was '/admin' while the console lived under the player app's basePath.)
export const PASSKEY_COOKIE_PATH = '/';

function adminUrl(): URL {
  return new URL(process.env.NEXT_PUBLIC_ADMIN_URL || DEFAULT_ADMIN_URL);
}

/**
 * WebAuthn Relying Party ID — the domain a credential is scoped to.
 *
 * A credential can be used from any origin that is a subdomain of its RP ID, so
 * pinning this to the PARENT domain (sfubadminton.com) means one passkey works
 * on both the apex and admin.sfubadminton.com, and survives moving the console
 * between them.
 *
 * Deriving it from the admin hostname instead — as this used to — silently
 * scopes credentials to whatever host the console currently sits on, so any
 * move invalidates every enrolled passkey. Admins then cannot pass the gate to
 * reach the page that enrolls a new one, which is an outright lockout.
 *
 * Set PASSKEY_RP_ID explicitly in production. The fallback strips a single
 * leading label ("admin.") to recover the registrable parent, which is correct
 * for this deployment; it is deliberately not a public-suffix parser.
 */
export function getRpId(): string {
  const explicit = process.env.NEXT_PUBLIC_PASSKEY_RP_ID;
  if (explicit) return explicit;

  const host = adminUrl().hostname;
  if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  const labels = host.split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : host;
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

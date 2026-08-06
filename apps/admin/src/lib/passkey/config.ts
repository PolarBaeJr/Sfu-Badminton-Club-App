// Passkey (WebAuthn) gate configuration. Shared by the Edge middleware, the
// /api/passkey route handlers, and the server-action belt-and-braces check —
// so keep this file free of Node-only imports.

import { BASE_PATH } from '../base-path';

const DEFAULT_ADMIN_URL = 'http://localhost:3001';

export const PASSKEY_VERIFIED_COOKIE = 'admin_passkey_verified';
export const PASSKEY_CHALLENGE_COOKIE = 'admin_passkey_challenge';
// Deliberately NOT the same cookie as the step-up gate above. /api/passkey/login
// is reachable without a session, so anyone can make a browser set its challenge
// cookie; sharing one name would let an unauthenticated request clobber a signed-
// in admin's in-flight enrol/step-up challenge. Two names, two independent flows.
export const PASSKEY_LOGIN_CHALLENGE_COOKIE = 'admin_passkey_login_challenge';

export const VERIFIED_TTL_SECONDS = 12 * 60 * 60; // 12h
export const CHALLENGE_TTL_SECONDS = 5 * 60; // 5min

// Scope the gate cookies to wherever the console is mounted — '/admin' in
// production, '/' only when it is root-mounted (localhost). It was '/admin'
// once before, for the same reason, and briefly '/' while it had a subdomain.
//
// This is not cosmetic. The console shares an origin with the player app now,
// so a '/' cookie here would ride along on every player-app request every exec
// makes — an admin-gate token handed to an app that has no business seeing it,
// on requests that have no business carrying it.
export const PASSKEY_COOKIE_PATH = BASE_PATH || '/';

function adminUrl(): URL {
  return new URL(process.env.NEXT_PUBLIC_ADMIN_URL || DEFAULT_ADMIN_URL);
}

/**
 * WebAuthn Relying Party ID — the domain a credential is scoped to.
 *
 * A credential can be used from any origin that is a subdomain of its RP ID, so
 * pinning this to the PARENT domain (sfubadminton.com) means one passkey works
 * on the apex and on any subdomain, and survives the console moving between
 * them. That is exactly what carried enrolled credentials through the move off
 * admin.sfubadminton.com and onto sfubadminton.com/admin: the RP ID did not
 * change, and a WebAuthn origin drops the path, so getExpectedOrigin() below
 * goes from "https://admin.sfubadminton.com" to "https://sfubadminton.com" —
 * still within the RP ID's scope.
 *
 * Deriving it from the console's hostname instead — as this used to — silently
 * scopes credentials to whatever host the console currently sits on, so any
 * move invalidates every enrolled passkey. Admins then cannot pass the gate to
 * reach the page that enrolls a new one, which is an outright lockout.
 *
 * Set PASSKEY_RP_ID explicitly in production. The fallback strips a single
 * leading label to recover the registrable parent for a subdomain host, and
 * returns a two-label host (sfubadminton.com) unchanged; it is deliberately not
 * a public-suffix parser.
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

/**
 * Whether the sign-in-with-a-passkey routes can operate — i.e. whether
 * getCookieSecret() would return rather than throw.
 *
 * The throw above is right for the gate: a gate with no secret must fail closed,
 * and every caller of it is already past authentication, so a 500 is a bug
 * report, not a lockout. The login routes are different — they are the FIRST
 * thing an unauthenticated visitor touches. Letting the throw escape there turns
 * a missing env var into an unhandled 500 on a public endpoint (and a stack
 * trace in Sentry for every click of the button).
 *
 * So the login routes still fail closed — no secret means no signed challenge
 * means no passkey sign-in — but they say so with a clean 503, the button hides
 * itself, and Google/magic-link carry on working. Nobody is locked out of the
 * console; they just lose one of three ways in.
 */
export function isPasskeyLoginConfigured(): boolean {
  if (process.env.ADMIN_PASSKEY_COOKIE_SECRET) return true;
  return process.env.NODE_ENV !== 'production';
}

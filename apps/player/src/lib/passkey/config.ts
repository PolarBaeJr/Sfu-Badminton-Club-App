// Passkey (WebAuthn) configuration for the PLAYER app, where a passkey is a
// primary sign-in method rather than the admin console's step-up gate.
//
// Keep this file free of Node-only imports: it is pulled in by route handlers
// that also run the Edge-safe cookie helpers.

const DEFAULT_PLAYER_URL = 'http://localhost:3000';

export const PASSKEY_CHALLENGE_COOKIE = 'player_passkey_challenge';
export const PASSKEY_COOKIE_PATH = '/';
export const CHALLENGE_TTL_SECONDS = 5 * 60; // 5min

function playerUrl(): URL {
  return new URL(process.env.NEXT_PUBLIC_APP_URL || DEFAULT_PLAYER_URL);
}

/**
 * WebAuthn Relying Party ID — the domain a credential is scoped to.
 *
 * Deliberately the SAME value the admin console uses. A credential is usable
 * from any origin under its RP ID, so pinning both apps to the registrable
 * parent (sfubadminton.com) means one passkey works on the apex and on
 * admin.sfubadminton.com, and an exec does not enrol twice.
 *
 * Set NEXT_PUBLIC_PASSKEY_RP_ID explicitly in production. The fallback strips a
 * single leading label to recover the parent; it is not a public-suffix parser.
 */
export function getRpId(): string {
  const explicit = process.env.NEXT_PUBLIC_PASSKEY_RP_ID;
  if (explicit) return explicit;

  const host = playerUrl().hostname;
  if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  const labels = host.split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : host;
}

export function getExpectedOrigin(): string {
  return playerUrl().origin;
}

/**
 * Null rather than throwing when unset.
 *
 * The admin equivalent throws in production, which is right for a gate that
 * must fail closed. Here a missing secret must NOT take down sign-in: passkeys
 * are one option beside Google and emailed codes, so the feature degrades to
 * "unavailable" — routes answer 503 and PasskeyManager hides the enrol button
 * (via the passkeysConfigured server action) — and everyone can still get in.
 *
 * The button-hiding half of that was only ever a claim in this comment. Until it
 * was implemented, a deployment missing PASSKEY_COOKIE_SECRET showed "Add a
 * passkey", and pressing it answered "Passkeys are not configured" — which the
 * member reads as a fault in their phone. The variable is documented in
 * .env.example precisely so it does not get missed again.
 */
export function getCookieSecret(): string | null {
  const secret = process.env.PASSKEY_COOKIE_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') return null;
  // Deterministic dev fallback so local sessions survive restarts.
  return 'player-passkey-dev-secret-do-not-use-in-production';
}

export function isPasskeyConfigured(): boolean {
  return getCookieSecret() !== null;
}

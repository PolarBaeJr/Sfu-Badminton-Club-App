// Deep link encoded into a player's profile QR code. Scanning it opens the
// normal challenge form with that player preselected — the QR is a shortcut
// into the existing createChallenge -> validate_challenge_creation path, never
// an authorization. A scan cannot accept anything on the opponent's behalf.

// Shape check only, matching what Postgres' uuid type accepts (any hex in the
// 8-4-4-4-12 layout); the version/variant nibbles are not constrained.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): boolean {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// Returns null when there is nothing safe to encode — an unset base URL
// (NEXT_PUBLIC_PLAYER_URL missing from the build env) or a playerId that is not
// a UUID. Callers render no QR at all rather than a link to
// "undefined/challenges/new?opponent=".
export function buildChallengeQrUrl(
  baseUrl: string | null | undefined,
  playerId: string
): string | null {
  if (!baseUrl) return null;
  if (!isUuid(playerId)) return null;
  // Env vars are commonly set with a trailing slash; strip so the joined path
  // never doubles up.
  const base = baseUrl.replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/challenges/new?opponent=${playerId}`;
}

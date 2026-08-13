// Reading a session check-in QR that was scanned INSIDE the app.
//
// Deep import, not the '@badminton/shared' barrel: this module is pulled into
// the client bundle by check-in-button.tsx, and the barrel re-exports the whole
// package (see the player middleware for the same reasoning). constants.ts has
// no dependencies.
import { CHECKIN_TOKEN_REGEX } from '@badminton/shared/src/utils/constants';

// ---------------------------------------------------------------------------
// THE POLICY SWITCH
// ---------------------------------------------------------------------------
// Does scanning the door code REPLACE tapping "Check In", or sit alongside it?
//
// The two axes are different. session_checkin_open() already bounds check-in by
// TIME; what the QR adds is PRESENCE — the code is taped to the door, so
// scanning it is evidence you walked through it. Tapping the button works from
// the bus.
//
//   false (default, and what ships)
//     Scanning is the primary action; the direct check-in stays as a secondary
//     "I can't scan" path. Nobody who could check in yesterday loses the
//     ability today, which is the only safe default for a live club.
//
//   true
//     Presence is required. The direct action is gone entirely — including
//     from the camera-denied fallback, which instead sends people to the
//     printed code and their phone's own camera app (the /checkin/[token]
//     landing page, unchanged and still working). Flip this and a member who
//     taps "Deny" once cannot use that to buy themselves a check-in from home.
//
// Deliberately a plain constant rather than an env var: it changes what
// attendance MEANS, so it should move by code review, not by a container
// restart nobody reviewed.
// The `: boolean` is load-bearing. Without it the type is the literal `false`,
// TypeScript narrows every `true` branch to unreachable, and the policy that is
// NOT currently in force stops being type-checked at all — which is the one
// thing you need working the day you flip it.
export const REQUIRE_SCAN_TO_CHECK_IN: boolean = false;

// A scanned value we could not turn into a session token. One message for every
// failure — a member holding a phone at the door does not benefit from knowing
// whether the code was malformed or simply someone else's.
export const UNREADABLE_SCAN_MESSAGE =
  "That doesn't look like a session check-in code. Point the camera at the code on the door.";

// Path form of the admin-displayed QR: it encodes an absolute
// `<playerBaseUrl>/checkin/<token>` so a phone's native camera also works.
// The optional leading segment absorbs a basePath, so a build served under a
// prefix still reads its own codes.
//
// Anchored on the `/checkin/<token>` SHAPE rather than hunting the string for
// 48 hex characters, and that is the whole point: the tournament QR is
// `/tournaments/checkin?token=<48 hex>` — an identically shaped token against a
// different table. A loose search would pull one out and feed it to
// checkInWithToken, which would reject it as "Invalid check-in code" — a code
// that is a perfectly valid check-in code, just not this kind.
const CHECKIN_PATH = /^(?:\/[^/]+)?\/checkin\/([^/?#]+)\/?$/;

/**
 * Extracts a session check-in token from whatever the camera decoded, or null.
 *
 * Accepts the absolute URL the admin console encodes, the same path relative,
 * a bare token (in case a code is ever generated as plain text), and the
 * `?checkin=<token>` form the sign-in round-trip uses. Everything else — a
 * tournament code, someone's profile QR, a poster advertising a website —
 * is a null, never a throw and never a guess.
 *
 * Deliberately does NOT check the host. Staging, production and the domain
 * being retired are all legitimate origins for the same club's codes, and the
 * token is resolved server-side anyway: a token from a stranger's QR is simply
 * a token that is not in the table.
 */
export function tokenFromCheckinScan(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Plain-text code.
  if (CHECKIN_TOKEN_REGEX.test(trimmed)) return trimmed;

  // One parse covers both absolute and relative values: an absolute URL ignores
  // the base, a relative one resolves against it. The base is never read back.
  let url: URL;
  try {
    url = new URL(trimmed, 'http://scan.invalid');
  } catch {
    return null;
  }

  const fromPath = CHECKIN_PATH.exec(url.pathname)?.[1];
  if (fromPath) {
    // The path segment is percent-decoded, which can itself throw on a
    // malformed escape (`%zz`) — a scan of arbitrary text must not crash here.
    let decoded: string;
    try {
      decoded = decodeURIComponent(fromPath);
    } catch {
      return null;
    }
    if (CHECKIN_TOKEN_REGEX.test(decoded)) return decoded;
    return null;
  }

  // `?checkin=` is what survives the sign-in redirect, so a code photographed
  // from that URL still reads. `?token=` is pointedly not accepted: that is the
  // tournament flow's parameter.
  const fromQuery = url.searchParams.get('checkin');
  if (fromQuery && CHECKIN_TOKEN_REGEX.test(fromQuery)) return fromQuery;

  return null;
}

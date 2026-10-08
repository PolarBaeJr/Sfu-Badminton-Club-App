// Reading a session check-in QR that was scanned INSIDE the app.
//
// Deep import, not the '@badminton/shared' barrel: this module is pulled into
// the client bundle by check-in-button.tsx, and the barrel re-exports the whole
// package (see the player middleware for the same reasoning). constants.ts has
// no dependencies.
import { CHECKIN_TOKEN_REGEX } from '@badminton/shared/src/utils/constants';

// ---------------------------------------------------------------------------
// THE POLICY SWITCH — now per session, not per deployment
// ---------------------------------------------------------------------------
// Does scanning the door code REPLACE tapping "Check In", or sit alongside it?
//
// The two axes are different. session_checkin_open() already bounds check-in by
// TIME; what the QR adds is PRESENCE — the code is taped to the door, so
// scanning it is evidence you walked through it. Tapping the button works from
// the bus.
//
//   false (the column default, and what every existing session keeps)
//     Scanning is the primary action; the direct check-in stays as a secondary
//     "I can't scan" path. Nobody who could check in yesterday loses the
//     ability today, which is the only safe default for a live club.
//
//   true
//     Presence is required for THAT NIGHT. Every direct affordance is gone —
//     the card's quiet "Check in without scanning", the fallback inside the
//     scanner dialog, and the server action behind them (see
//     checkInToSessionImpl). The camera-denied fallback instead sends people to
//     the printed code and their phone's own camera app: /checkin/[token] is
//     unchanged, still works, and needs no in-browser camera permission. A
//     member who taps "Deny" once cannot use that to buy a check-in from home.
//
// WHY THE SESSION AND NOT THE CLUB. This was a module-level constant, which
// made it a property of the deployment: flipping it changed what attendance
// meant for every night at once, including the casual drop-ins where checking
// in from the bus is fine. Presence is a property of the NIGHT — a ladder final
// wants it, a Sunday social does not — and `sessions` is the only table with a
// row per night. platform_settings would have reproduced the global switch with
// extra steps.
//
// It is NOT a property of the season or the track: both would have to be
// re-decided every time either changes, and a term with one strict night in it
// has no way to say so.

/** The shape this reads off a session row. Optional and nullable on purpose:
 *  the migration is applied by hand, so the app must run against a database
 *  that does not have the column yet. */
export interface ScanPolicySession {
  require_scan_to_check_in?: boolean | null;
}

/**
 * Does this session require the door code?
 *
 * Absent, null and false all mean no. That is the safe direction on every axis
 * at once: before the migration lands the column is missing from every row, and
 * "missing" must not silently become "required" and lock a whole club out of
 * check-in on the strength of a deploy that ran ahead of its SQL.
 */
export function requiresScanToCheckIn(session: ScanPolicySession | null | undefined): boolean {
  return session?.require_scan_to_check_in === true;
}

/** Which ways into check-in a session offers, besides the scanner itself. */
export interface CheckInAffordances {
  /** The card's quiet "Check in without scanning" text control. */
  directOnCard: boolean;
  /** The same action, offered again at the bottom of the scanner dialog. */
  directInDialog: boolean;
  /**
   * What the scanner dialog says to somebody whose camera never started.
   *
   * 'direct'       — offer the button; they can check in without a camera.
   * 'printed-code' — point at the printed code and the phone's own camera app.
   */
  cameraFallback: 'direct' | 'printed-code';
}

/**
 * The affordance set for one session, in one place.
 *
 * Both the card and the dialog read this rather than testing the flag
 * themselves, because the property that matters is a property of the WHOLE
 * screen: under scan-required there must be no direct route left anywhere, and
 * that is a claim about the set, not about any one button. Three separate
 * `requireScan ? …` ternaries scattered across a component is exactly how one
 * of them survives a refactor and quietly reopens check-in-from-home.
 */
export function checkInAffordances(requireScan: boolean): CheckInAffordances {
  if (requireScan) {
    return { directOnCard: false, directInDialog: false, cameraFallback: 'printed-code' };
  }
  return { directOnCard: true, directInDialog: true, cameraFallback: 'direct' };
}

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
